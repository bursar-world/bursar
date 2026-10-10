/**
 * What each assistant needs typed into it, filled in.
 *
 * Two forms of the same endpoint. Clients that send a header get the token as a bearer; clients
 * whose connector form takes a URL and nothing else get the token in the path. The second puts the
 * secret in a URL, which proxies and the operator's own request logs will see, and the settings
 * say so.
 */

export type ConnectorSettings = {
  readonly endpoint: string;
  /** The same endpoint with the token in its path, for a connector form that takes no header. */
  readonly endpointWithToken: string;
  readonly chatgpt: { readonly name: string; readonly url: string; readonly authentication: string; readonly steps: readonly string[] };
  readonly claude: { readonly name: string; readonly url: string; readonly steps: readonly string[] };
  readonly claudeCode: { readonly command: string };
  readonly gemini: { readonly settings: string; readonly steps: readonly string[] };
};

export function connectorSettings(publicUrl: string, token: string): ConnectorSettings {
  const endpoint = `${publicUrl}/mcp`;
  const endpointWithToken = `${publicUrl}/mcp/${token}`;
  const bearer = `Bearer ${token}`;

  return {
    endpoint,
    endpointWithToken,
    chatgpt: {
      name: 'Bursar',
      url: endpointWithToken,
      authentication: 'No authentication',
      steps: [
        'Open Settings, then Connectors, then Create.',
        `Name it Bursar. Paste the URL. Set Authentication to "No authentication": the token travels in the URL.`,
        'Turn on Developer mode under Settings, Connectors, Advanced, if the connector form is not shown.',
        'In a new chat, enable the Bursar connector from the plus menu and ask it to pay.',
      ],
    },
    claude: {
      name: 'Bursar',
      url: endpointWithToken,
      steps: [
        'Open Settings, then Connectors, then Add custom connector.',
        'Name it Bursar and paste the URL. Leave the OAuth fields empty: the token travels in the URL.',
        'In a chat, open the tools menu, enable Bursar, and ask it to pay.',
      ],
    },
    claudeCode: {
      command: `claude mcp add --transport http bursar ${endpoint} --header "Authorization: ${bearer}"`,
    },
    gemini: {
      settings: JSON.stringify(
        { mcpServers: { bursar: { httpUrl: endpoint, headers: { Authorization: bearer }, timeout: 60_000 } } },
        null,
        2,
      ),
      steps: [
        'Open ~/.gemini/settings.json (or the project’s .gemini/settings.json) and add the block under mcpServers.',
        'Start Gemini CLI and run /mcp to see the Bursar tools listed.',
        'Ask it to pay.',
      ],
    },
  };
}
