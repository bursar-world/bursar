# @bursar/create-provider

Scaffolds a Cloudflare Worker that charges agents through Bursar.

```
npm create @bursar/provider my-api
cd my-api
npm install
npx wrangler secret put BURSAR_FACILITATOR_TOKEN
npx wrangler deploy
```

The project it writes is the `templates/cloudflare-worker` template from the repository: one priced
route, `POST /render`, charged through [`@bursar/provider-worker`](https://www.npmjs.com/package/@bursar/provider-worker).
Its README says what to set before deploying and how an agent pays it.
