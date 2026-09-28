---
name: setup-secrets
description: 'Help configure Ficus credentials through their owning settings pages, keeping agent-model access separate from API services.'
---

# Setting Up Credentials

Ficus encrypts stored secrets with AES-256-GCM. Server bootstrap requires `DATABASE_URL` and `FICUS_ENCRYPTION_KEY`; provider and service credentials should normally be configured through the UI.

This skill is for the System Manager helping a human configure their instance. Check existing configuration before suggesting changes:

```bash
ficus provider-auth list
ficus integration list --json
ficus secret list
```

Do not ask the human to paste credentials into chat. Direct them to the owning settings page. Do not use `ficus secret set` for integration-owned credentials; their legacy secret endpoints are retired. Saved integration secrets cannot be revealed: enter a replacement to rotate them. Webhook panels can generate a new signing secret for the human to copy into the provider before saving it.

## Agent Models

Use **Settings → AI Providers** for agent-model API keys or subscription login. Configure the desired accounts and model-provider enable states there. These control model selection and fallback. Use the UI’s device or browser login instructions for supported subscription providers.

## OpenAI API Services

Use **Settings → Integrations → OpenAI API services** for realtime voice, transcription, and memory embeddings. This is independent of OpenAI/ChatGPT agent-model accounts. Enabling services must not enroll OpenAI in model fallback, and enabling an agent account does not configure API services. The Memory settings page also controls whether automatic embeddings run.

For services-only setup, save the key in the integration rather than exporting `OPENAI_API_KEY` into the server environment, which retains its legacy model-provider discovery behavior. Existing server environment credentials are not silently removed; help the operator disable unwanted agent providers in AI Providers.

## Google Cloud Speech

Use **Settings → Integrations → Google Cloud** for message read-aloud. Enable Google Cloud Text-to-Speech in the relevant project and paste the service-account JSON key into the card. Saved JSON stays hidden; replacement credentials take effect for new speech requests without a restart.

Administrators can alternatively configure Application Default Credentials on the server. A file path belongs in the server’s `GOOGLE_APPLICATION_CREDENTIALS` environment setting, not in the JSON field. The integration must still be enabled. Google Cloud speech does not supply OpenAI transcription or realtime credentials.

## Other Integrations

- GitHub: connect an account through Integrations. Standalone instances support device login; hosted instances use the Platform broker. Check GitHub App repository installations and the squad’s selected/inherited account.
- Linear, Notion, and Bigbrain: configure their integration cards and squad-specific access.
- Discord, Slack, and Telegram: enable the integration, enter its credentials, then configure routing. See the channel setup skills for provider-specific steps.
- Cloudflare, DigitalOcean, Netlify, Railway, Supabase, and Vercel: save tokens in their integration cards. Preserve explicit squad Environment exposure choices; see the deployment skills.
- GitHub and Linear webhook signing: use their integration webhook panels, not legacy secret commands.

## Remaining Infrastructure Secrets

There is no Secrets & Keys page. Git author overrides are under Settings → Git; the self-hosted exe.dev account key is under Machines. Apple Push and Web Push credentials live in Integrations. The bootstrap admin password is deployment configuration; personal authentication is managed under Account. Hosted deployments hide platform infrastructure credentials, including the exe.dev key. Do not ask hosted users to configure or reveal that key.

The encryption key belongs in the server environment, not in the secret store. Changing bootstrap/database settings may require a controlled restart. Do not restart for Google speech or OpenAI API-service credential rotation.

## Troubleshooting

| Problem                                    | Check                                                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Secret store unavailable                   | Server `FICUS_ENCRYPTION_KEY` configuration                                                                 |
| Agent-model authentication                 | AI Providers account, provider enable state, and `ficus provider-auth get <provider>`                       |
| Unexpected OpenAI fallback                 | AI Providers and legacy server environment credentials; API-services setup alone must not enroll a provider |
| Voice/transcription/embeddings unavailable | OpenAI API services switch and key; Memory’s embeddings switch                                              |
| Message read-aloud unavailable             | Google Cloud switch, service-account JSON or server ADC, and Text-to-Speech API access                      |
| GitHub commands fail                       | Global/squad integration enable state, selected account, and App repository access                          |
