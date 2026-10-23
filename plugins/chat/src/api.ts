/**
 * Name of the endpoint API key in this plugin's secrets (`plugin:chat:apiKey`). Core chat reads it
 * first (else `chat.apiKey` from `quadflow chat key set`); `settingsGet().hasApiKey` reports it.
 */
export const API_KEY_SECRET = 'apiKey'
