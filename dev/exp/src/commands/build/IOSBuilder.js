/**
 * @flow
 */

import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import untildify from 'untildify';
import { Exp, Credentials, XDLError, ErrorCode } from 'xdl';

import type { IOSCredentials, CredentialMetadata } from 'xdl/src/Credentials';
import BaseBuilder from './BaseBuilder';
import log from '../../log';

import * as authFuncs from '../../local-auth/auth';

/**
 * Steps:
 * 1) Check for active builds -- only one build per user/experience can happen at once
 * 2) Check for Apple ID credentials for this user/experience
 * 		a) If they don't exist, prompt user to enter them. Submit them to server (/-/api/credentials/add),
 * 			 which will verify and store them.
 * 3) Check for valid cert for this user/experience
 * 		a) If valid cert doesn't exist, prompt user:
 * 	 			i) Do you have a certificate you'd like to use for signing this application, or would you like us
 * 	 				 to generate them for you?
 * 	 				 This is most common when you have other apps in the App Store, you're replacing an existing
 * 	 				 app in the App Store with an Exponent app, or you'd simply like more control over your Apple
 * 	 				 Developer account.
 * 	 	    ii) If they choose to upload a cert, ask them for the path to .p12 file. Upload the p12 (/-/api/credentials/add).
 * 	 	    iii) If they want us to manage it, call to /-/api/credentials/generate-certs, and verify that we were able to generate the cert
 * 	 	b) If a cert exists, the server will verify that it is still valid.
 * 4) Publish the experience from the local packager.
 * 5) Initiate build process.
 */
export default class IOSBuilder extends BaseBuilder {
  async run() {
    // validate bundleIdentifier before hitting the network to check build status
    const {
      args: {
        username,
        remoteFullPackageName: experienceName,
        bundleIdentifierIOS: bundleIdentifier,
      },
    } = await Exp.getPublishInfoAsync(this.projectDir);

    if (!bundleIdentifier) {
      throw new XDLError(
        ErrorCode.INVALID_OPTIONS,
        `Your project must have a bundleIdentifier set in app.json. See https://docs.expo.io/versions/latest/guides/building-standalone-apps.html`
      );
    }

    // Check the status of any current builds
    await this.checkStatus();
    // Check for existing credentials, collect any missing credentials, and validate them
    if (this.options.type !== 'simulator') {
      try {
        await this.collectAndValidateCredentials(username, experienceName, bundleIdentifier);
      } catch (e) {
        log.error(
          'Error validating credentials. You may need to clear them (with `-c`) and try again.'
        );
        throw e;
      }
    }
    // Publish the experience
    const publishedExpIds = await this.publish();
    // Initiate the build with the published experience
    await this.build(publishedExpIds, 'ios');
  }

  _throwIfFailureWithReasonDump(replyAttempt) {
    if (replyAttempt.result === 'failure') {
      const { reason, rawDump } = replyAttempt;
      throw new Error(`Reason:${reason}, raw:${JSON.stringify(rawDump)}`);
    }
  }

  // Getting an undefined anywhere here probably means a ruby script
  // is throwing an exception
  async _fullLocalAuthRun(metadata) {
    const creds: IOSCredentials = await this.askForAppleId({ askForTeamId: false });
    log('Validating Credentials...');
    const checkCredsAttempt = await authFuncs.validateCredentials(creds, metadata);
    this._throwIfFailureWithReasonDump(checkCredsAttempt);
    const { teamId } = checkCredsAttempt;
    log('Creating Certificates...');
    const produceCertAttempt = await authFuncs.produceCerts(creds);
    this._throwIfFailureWithReasonDump(produceCertAttempt);
    const { p12password, p12, privateSigningKey } = produceCertAttempt;
    log('Making sure that we have an AppID on the Developer Portal...');
    let checkAppExistenceAttempt = await authFuncs.ensureAppIdLocally(creds, metadata, teamId);
    if (
      checkAppExistenceAttempt.result === 'failure' &&
      checkAppExistenceAttempt.reason.startsWith('App could not be found for bundle id')
    ) {
      checkAppExistenceAttempt = await authFuncs.createAppOnPortal(creds, metadata, teamId);
    }
    this._throwIfFailureWithReasonDump(checkAppExistenceAttempt);
    const { appId, features, enabledFeatures } = checkAppExistenceAttempt;
    log('Creating Push Certificates...');
    const producePushCertsAttempt = await authFuncs.producePushCerts(creds, metadata);
    this._throwIfFailureWithReasonDump(producePushCertsAttempt);
    const {
      privateSigningKey: privateSigningKeyPushCert,
      pushP12,
      pushP12password,
    } = producePushCertsAttempt;

    log('Creating Provisioning Profile...');
    const produceProvisionProfileAttempt = await authFuncs.produceProvisionProfile(creds, metadata);
    this._throwIfFailureWithReasonDump(produceProvisionProfileAttempt);
    const { provisioningProfile } = produceProvisionProfileAttempt;
    const freshCreds = {
      teamId,
      certP12: p12,
      certPassword: p12password,
      pushP12,
      pushP12password,
      provisioningProfile,
      appId,
      features: JSON.stringify(features),
      enabledFeatures: JSON.stringify(enabledFeatures),
      privateSigningKey,
      privateSigningKeyPushCert,
      clientExpMadeCerts: 'true',
    };
    log('Updating credentials with expo...');
    await Credentials.updateCredentialsForPlatform('ios', freshCreds, metadata);
  }

  async _localCollectAndValidateCredentials(creds: ?IOSCredentials, metadata: CredentialMetadata) {
    try {
      // In the case when user has no credentials at all, get everything
      if (creds === undefined) {
        return await this._fullLocalAuthRun(metadata);
      } else {
        if (!creds.certP12 || !creds.pushP12 || !creds.provisionProfile) {
          const userCreds: IOSCredentials = await this.askForAppleId({ askForTeamId: false });
          let credentials = {};
          if (creds.certP12 === undefined) {
            log('Creating Certificates...');
            const produceCertAttempt = await authFuncs.produceCerts(userCreds);
            this._throwIfFailureWithReasonDump(produceCertAttempt);
            const { p12password, p12, privateSigningKey } = produceCertAttempt;
            credentials = {
              ...credentials,
              certP12: p12,
              certPassword: p12password,
            };
          }
          if (creds.pushP12 === undefined) {
            const producePushCertsAttempt = await authFuncs.producePushCerts(userCreds, metadata);
            this._throwIfFailureWithReasonDump(producePushCertsAttempt);
            const {
              privateSigningKey: privateSigningKeyPushCert,
              pushP12,
              pushP12password,
            } = producePushCertsAttempt;
            credentials = {
              ...credentials,
              pushP12,
              pushP12password,
            };
          }
          if (creds.provisioningProfile === undefined) {
            const produceProvisionProfileAttempt = await authFuncs.produceProvisionProfile(
              userCreds,
              metadata
            );
            this._throwIfFailureWithReasonDump(produceProvisionProfileAttempt);
            const { provisioningProfile } = produceProvisionProfileAttempt;
            credentials = {
              ...credentials,
              provisioningProfile,
            };
          }
          credentials = { ...credentials, clientExpMadeCerts: 'true' };
          await Credentials.updateCredentialsForPlatform('ios', credentials, metadata);
        }
      }
    } catch (e) {
      throw e;
    } finally {
      await authFuncs.cleanUp();
    }
  }

  async collectAndValidateCredentials(
    username: string,
    experienceName: string,
    bundleIdentifier: string
  ) {
    const credentialMetadata = {
      username,
      experienceName,
      bundleIdentifier,
      platform: 'ios',
    };
    log('Checking for existing Apple credentials...');
    const existingCredentials: ?IOSCredentials = await Credentials.credentialsExistForPlatformAsync(
      credentialMetadata
    );

    if (this.options.localAuth) {
      return await this._localCollectAndValidateCredentials(
        existingCredentials,
        credentialMetadata
      );
    } else {
      let hasAppleId, hasCert, hasPushCert;
      if (this.options.clearCredentials || !existingCredentials) {
        hasAppleId = false;
        hasCert = false;
        hasPushCert = false;
      } else if (existingCredentials) {
        hasAppleId = !!existingCredentials.appleId;
        hasCert = !!existingCredentials.certP12;
        hasPushCert = !!existingCredentials.pushP12;
      }

      if (!hasAppleId) {
        const credentials = await this.askForAppleId({ askForTeamId: true });
        log('Validating Apple credentials...');
        await Credentials.validateCredentialsForPlatform(
          'ios',
          'appleId',
          credentials,
          credentialMetadata
        );
        await Credentials.updateCredentialsForPlatform('ios', credentials, credentialMetadata);
      } else {
        log('Validating Apple credentials...');
        await Credentials.validateCredentialsForPlatform(
          'ios',
          'appleId',
          null,
          credentialMetadata
        );
      }
      log('Credentials valid.');

      if (!hasCert) {
        await this.askForCerts(credentialMetadata);
      } else {
        log('Validating distribution certificate...');
        await Credentials.validateCredentialsForPlatform('ios', 'cert', null, credentialMetadata);
      }

      // ensure that the app id exists or is created
      try {
        log('Validating app id...');
        await Credentials.ensureAppId(credentialMetadata);
      } catch (e) {
        throw new XDLError(
          ErrorCode.CREDENTIAL_ERROR,
          `It seems like we can't create an app on the Apple developer center with this app id: ${credentialMetadata.bundleIdentifier}. Please change your bundle identifier to something else.`
        );
      }
      if (!hasPushCert) {
        await this.askForPushCerts(credentialMetadata);
      } else {
        log('Validating push certificate...');
        await Credentials.validateCredentialsForPlatform('ios', 'push', null, credentialMetadata);
      }
    }
  }

  async askForAppleId(opts) {
    // ask for creds
    console.log('');
    console.log(
      'We need your Apple ID/password to manage certificates and provisioning profiles from your Apple Developer account.'
    );
    const questions = [
      {
        type: 'input',
        name: 'appleId',
        message: `What's your Apple ID?`,
        validate: val => val !== '',
      },
      {
        type: 'password',
        name: 'password',
        message: `Password?`,
        validate: val => val !== '',
      },
    ];
    if (opts.askForTeamId) {
      questions.push({
        type: 'input',
        name: 'teamId',
        message: `What is your Apple Team ID (you can find that on this page: https://developer.apple.com/account/#/membership)?`,
        validate: val => val !== '',
      });
    }
    const answers = await inquirer.prompt(questions);

    const credentials: IOSCredentials = {
      appleId: answers.appleId,
      password: answers.password,
      teamId: answers.teamId,
    };
    return credentials;
  }

  async askForCerts(credentialMetadata: CredentialMetadata) {
    // ask about certs
    console.log(``);

    const questions = [
      {
        type: 'rawlist',
        name: 'manageCertificates',
        message: `Do you already have a distribution certificate you'd like us to use,\nor do you want us to manage your certificates for you?`,
        choices: [
          { name: 'Let Expo handle the process!', value: true },
          { name: 'I want to upload my own certificate!', value: false },
        ],
      },
      {
        type: 'input',
        name: 'pathToP12',
        message: 'Path to P12 file:',
        validate: async p12Path => {
          try {
            const stats = await fs.stat.promise(p12Path);
            return stats.isFile();
          } catch (e) {
            // file does not exist
            console.log('\nFile does not exist.');
            return false;
          }
        },
        filter: p12Path => {
          p12Path = untildify(p12Path);
          if (!path.isAbsolute(p12Path)) {
            p12Path = path.resolve(p12Path);
          }
          return p12Path;
        },
        when: answers => !answers.manageCertificates,
      },
      {
        type: 'password',
        name: 'certPassword',
        message: 'Certificate P12 password:',
        validate: password => password.length > 0,
        when: answers => !answers.manageCertificates,
      },
    ];

    const answers = await inquirer.prompt(questions);

    if (answers.manageCertificates) {
      // Attempt to fetch new certificates
      log('Generating distribution certificate...');
      await Credentials.fetchAppleCertificates(credentialMetadata);
    } else {
      // Upload credentials
      const p12Data = await fs.readFile.promise(answers.pathToP12);
      const credentials = {
        certP12: p12Data.toString('base64'),
        certPassword: answers.certPassword,
      };
      log('Validating distribution certificate...');
      await Credentials.validateCredentialsForPlatform(
        'ios',
        'cert',
        credentials,
        credentialMetadata
      );
      await Credentials.updateCredentialsForPlatform('ios', credentials, credentialMetadata);
    }

    log('Distribution certificate setup complete.');
  }

  async askForPushCerts(credentialMetadata: CredentialMetadata) {
    // ask about certs

    const questions = [
      {
        type: 'rawlist',
        name: 'managePushCertificates',
        message: `Do you already have a push notification certificate you'd like us to use,\nor do you want us to manage your push certificates for you?`,
        choices: [
          { name: 'Let Expo handle the process!', value: true },
          { name: 'I want to upload my own certificate!', value: false },
        ],
      },
      {
        type: 'input',
        name: 'pathToP12',
        message: 'Path to P12 file:',
        validate: async p12Path => {
          try {
            const stats = await fs.stat.promise(p12Path);
            return stats.isFile();
          } catch (e) {
            // file does not exist
            console.log('\nFile does not exist.');
            return false;
          }
        },
        filter: p12Path => {
          p12Path = untildify(p12Path);
          if (!path.isAbsolute(p12Path)) {
            p12Path = path.resolve(p12Path);
          }
          return p12Path;
        },
        when: answers => !answers.managePushCertificates,
      },
      {
        type: 'password',
        name: 'pushPassword',
        message: 'Push certificate P12 password (empty is OK):',
        when: answers => !answers.managePushCertificates,
      },
    ];

    const answers: {
      managePushCertificates: boolean,
      pathToP12?: string,
      pushPassword?: string,
    } = await inquirer.prompt(questions);

    if (answers.managePushCertificates) {
      // Attempt to fetch new certificates
      log('Fetching a new push certificate...');
      await Credentials.fetchPushCertificates(credentialMetadata);
    } else {
      // Upload credentials
      const p12Data = await fs.readFile.promise(answers.pathToP12);

      const credentials: IOSCredentials = {
        pushP12: p12Data.toString('base64'),
        pushPassword: answers.pushPassword,
      };

      log('Validating push certificate...');
      await Credentials.validateCredentialsForPlatform(
        'ios',
        'push',
        credentials,
        credentialMetadata
      );
      await Credentials.updateCredentialsForPlatform('ios', credentials, credentialMetadata);
    }
    log('Push certificate setup complete.');
  }
}
