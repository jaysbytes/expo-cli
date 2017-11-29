# So that we can require funcs.rb
$LOAD_PATH.unshift File.expand_path(__dir__, __FILE__)

require 'funcs'
require 'spaceship'
require 'json'
# This provides the ask function which asks enduser for creds
require 'highline/import'
require 'base64'

$appleId, $password = ARGV

json_reply = with_captured_stderr{
  begin
    Spaceship::Portal.login($appleId, $password)
    csr, pkey = Spaceship.certificate.create_certificate_signing_request()
    Spaceship::Portal.certificate.production.create!(csr: csr)
    certs = Spaceship::Portal.certificate.production.all()
    cert_content = certs.last.download()
    p12password = SecureRandom.base64()
    p12 = OpenSSL::PKCS12.create(p12password, 'key', pkey, cert_content)
    $stderr.puts(JSON.generate({result:'success',
                                privateSigningKey:pkey,
                                p12:Base64.encode64(p12.to_der),
                                p12password:p12password}))
  rescue Spaceship::Client::UnexpectedResponse => e
    r = "#{e.error_info['userString']} #{e.error_info['resultString']}"
    $stderr.puts(JSON.generate({result:'failure',
                                reason:r,
                                rawDump:e.error_info}))
  rescue Spaceship::Client::InvalidUserCredentialsError => invalid_cred
    $stderr.puts(JSON.generate({result:'failure',
                                reason:'Invalid credentials',
                                rawDump:invalid_cred.preferred_error_info}))
  rescue Exception => e
    $stderr.puts(JSON.generate({result:'failure',
                                reason:'Unknown reason',
                                rawDump:e.message}))
  end
}

$stderr.puts json_reply
