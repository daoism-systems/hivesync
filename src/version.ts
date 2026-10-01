/**
 * The package version, read from package.json so `npm version` is the only
 * place it changes. `require` (not `import`) keeps package.json outside tsc's
 * rootDir; the relative path resolves from both src/ (ts-node) and dist/.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
export const VERSION: string = require('../package.json').version;
