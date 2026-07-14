import path from 'node:path';

const DATA_DIR = process.env.ROTV_DATA_DIR || '/opt/apps/rotv-guide/public/data';

export const FILES = Object.freeze({
  epgFull:   path.join(DATA_DIR, 'epg-normalized.json'),
  epgHome:   path.join(DATA_DIR, 'epg-homepage.json'),
  streaming: path.join(DATA_DIR, 'streaming-full.json'),
  tonight:   path.join(DATA_DIR, 'tonight-picks.json'),
});

export { DATA_DIR };
