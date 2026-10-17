# Agent key encryption

The website creates the Hyperliquid agent private key in the browser. Before any database request, it encrypts the key with RSA-OAEP using SHA-256 and stores it as `rsa1.<base64url ciphertext>`. Supabase never receives the plaintext key, and the website does not need `API_ENCRYPTION_KEY` or a service-role key.

## Public and private key setup

Create one RSA key pair for the trusted executor. Keep the private key in the executor's secret store; expose only the base64 DER SubjectPublicKeyInfo public key as `NEXT_PUBLIC_AGENT_ENCRYPTION_PUBLIC_KEY` to the website build.

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out executor-private.pem
openssl pkey -in executor-private.pem -pubout -outform DER | openssl base64 -A
```

The second command prints the value for `NEXT_PUBLIC_AGENT_ENCRYPTION_PUBLIC_KEY`. Do not put `executor-private.pem` or its contents in the website project or web host.

The current executor only decrypts legacy `v1` AES-GCM envelopes. Newly saved `rsa1` accounts stay `pending`; they cannot be activated by a browser user. Add `rsa1` decryption to the trusted executor before enabling live execution for these rows. The executor's private key must use the matching RSA-OAEP/SHA-256 key pair.
