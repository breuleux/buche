// Shared config for key forwarding to iframes.
// Set by renderer.js after buchekeys is initialized; read by DataHandler on iframe ready.
let _config = null;

export function setIframeKeysConfig(config) {
  _config = config;
}

export function getIframeKeysConfig() {
  return _config;
}
