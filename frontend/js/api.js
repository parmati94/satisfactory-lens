/**
 * Generic fetch wrapper for the Satisfactory Lens API.
 * Throws on non-2xx responses with the server's error message.
 */
async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export const api = {
  auth: {
    login: (username, password) =>
      apiFetch('/api/auth/login', { method: 'POST', body: { username, password } }),
    logout: () => apiFetch('/api/auth/logout', { method: 'POST' }),
    status: () => apiFetch('/api/auth/status'),
  },

  sf: {
    status: () => apiFetch('/api/sf/status'),
    connect: (host, port, password) =>
      apiFetch('/api/sf/connect', { method: 'POST', body: { host, port, password } }),
    disconnect: () => apiFetch('/api/sf/disconnect', { method: 'POST' }),
  },

  server: {
    state: () => apiFetch('/api/server/state'),
    health: () => apiFetch('/api/server/health'),
  },

  saves: {
    list: () => apiFetch('/api/saves'),
    load: (sessionName, saveName) =>
      apiFetch('/api/saves/load', { method: 'POST', body: { sessionName, saveName } }),
    save: (saveName) =>
      apiFetch('/api/saves/save', { method: 'POST', body: { saveName } }),
    delete: (saveName) =>
      apiFetch(`/api/saves/${encodeURIComponent(saveName)}`, { method: 'DELETE' }),
  },

  settings: {
    server: () => apiFetch('/api/settings/server'),
    advanced: () => apiFetch('/api/settings/advanced'),
    setServer: (options) => apiFetch('/api/settings/server', { method: 'PATCH', body: options }),
    setAdvanced: (settings) => apiFetch('/api/settings/advanced', { method: 'PATCH', body: settings }),
  },

  save: {
    status: () => apiFetch('/api/save/status'),
    reload: () => apiFetch('/api/save/reload', { method: 'POST' }),
    download: (saveName, saveDateTime) =>
      apiFetch('/api/save/download', { method: 'POST', body: { saveName, saveDateTime } }),
    watch: () => apiFetch('/api/save/watch', { method: 'POST' }),
    players: () => apiFetch('/api/save/players'),
    buildings: () => apiFetch('/api/save/buildings'),
    power: () => apiFetch('/api/save/power'),
    resourceNodes: () => apiFetch('/api/save/resource-nodes'),
    mapPins: () => apiFetch('/api/save/map-pins'),
    storage: () => apiFetch('/api/save/storage'),
    buildingFootprints: () => apiFetch('/api/save/building-footprints'),
    machineInstances: (cls) => apiFetch('/api/save/machine-instances?class=' + encodeURIComponent(cls)),
    schematics: () => apiFetch('/api/save/schematics'),
    persistEdits: ({ saveName, mode, edits }) =>
      apiFetch('/api/save/edit/persist', { method: 'POST', body: { saveName, mode, edits } }),
  },

  items: () => apiFetch('/api/items'),
  schematicCatalog: () => apiFetch('/api/schematics'),
  groundHeight: (x, y) => apiFetch(`/api/world/ground-height?x=${Math.round(x)}&y=${Math.round(y)}`),
};
