#!/usr/bin/env node
import '../src/envLoader.js';
import prospector from '../services/prospectorService.js';

function readCliOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [name, inlineValue] = arg.split('=');
    const value = inlineValue ?? argv[index + 1];
    if (name === '--keywords' && value) {
      options.keywords = value;
      if (inlineValue === undefined) index += 1;
    } else if (name === '--niche' && value) {
      options.niche = value;
      if (inlineValue === undefined) index += 1;
    } else if (name === '--country' && value) {
      options.country = value;
      if (inlineValue === undefined) index += 1;
    } else if (name === '--limit' && value) {
      options.limit = value;
      if (inlineValue === undefined) index += 1;
    }
  }
  return options;
}

(async () => {
  try {
    console.log('Running prospector...');
    const stats = await prospector.runProspector(readCliOptions(process.argv.slice(2)));
    console.log('Prospector finished:', stats);
    process.exit(0);
  } catch (e) {
    console.error('Prospector failed:', e && e.message ? e.message : e);
    process.exit(2);
  }
})();
