const token = '8505291976:AAFiWVvgvRH69GJPmI-dYpod0liNMA1QJjM';
const secret = 'einsoft-gps-secret-2024';
const webhookUrl = 'https://einsoft-gp-sbcknd.vercel.app/api/bot/webhook';

async function main() {
  const setRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    }),
  });
  const setData = await setRes.json();
  console.log('setWebhook Result:', JSON.stringify(setData, null, 2));

  const infoRes = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  const infoData = await infoRes.json();
  console.log('Current Webhook Info:', JSON.stringify(infoData, null, 2));
}

main().catch(console.error);
