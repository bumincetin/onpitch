// metro.config.js
//
// Metro defaults assume a single-package project: watch this folder, resolve modules by walking
// parent directories until something matches. Neither assumption holds inside an npm-workspaces
// monorepo. Each block below overrides one default and records what breaks without it.

const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

/** apps/mobile — the Expo project itself. */
const projectRoot = __dirname
/** The workspace root that owns node_modules and packages/shared. */
const workspaceRoot = path.resolve(projectRoot, '..', '..')

const config = getDefaultConfig(projectRoot)

// 1. WATCH THE WORKSPACE ROOT.
//    @onpitch/shared is a symlink in node_modules pointing at ../../packages/shared. Metro only
//    reads files inside projectRoot plus watchFolders, so without this the bundler reports
//    "Unable to resolve module @onpitch/shared/domain", and edits to the shared TrueSkill engine
//    never trigger a reload because nothing is watching those files.
config.watchFolders = [workspaceRoot]

// 2. SPELL OUT WHERE node_modules LIVE, NEAREST FIRST.
//    npm hoists most dependencies to <root>/node_modules but leaves version-conflicting ones in
//    apps/mobile/node_modules. Metro has to look in both, and it has to look in the project's own
//    copy FIRST so a locally pinned package wins over a hoisted one.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]

// 3. TURN OFF THE PARENT-DIRECTORY WALK.
//    Node's default algorithm climbs from the importing file upward, so a file in
//    packages/shared/src resolves `react` against packages/shared/node_modules first. When npm has
//    left a stray copy there, the app ends up with TWO Reacts loaded at once: hooks throw
//    "Invalid hook call", and the error points at the component, not at the duplicate. Disabling
//    hierarchical lookup makes nodeModulesPaths above the only search path, so there is exactly
//    one React no matter which file does the importing.
config.resolver.disableHierarchicalLookup = true

// 4. HONOUR THE "exports" MAP IN package.json.
//    @onpitch/shared has no build step and no files at its package root; "@onpitch/shared/domain"
//    only resolves through the subpath exports map that points at src/domain.ts. Metro enables
//    package exports by default at this version, but the flag is set explicitly because turning it
//    off — or a future default flip — breaks every shared import at once with a resolution error
//    that reads like a typo.
config.resolver.unstable_enablePackageExports = true

// 5. WEB PREVIEW ONLY: STUB THE NATIVE STRIPE SDK.
//    @stripe/stripe-react-native is native-only — it imports codegenNativeComponent, which does
//    not exist on web — so `expo start --web` cannot bundle the app at all. Web is not a shipping
//    target here; it exists so the UI can be reviewed in a browser without a device build. The
//    shim renders children and makes the payment calls return an error, so a web preview can
//    never look like a working checkout. iOS and Android resolve the real package unchanged.
const defaultResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && moduleName === '@stripe/stripe-react-native') {
    return {
      type: 'sourceFile',
      filePath: path.resolve(projectRoot, 'lib/stripe-web-shim.tsx'),
    }
  }
  return (defaultResolveRequest ?? context.resolveRequest)(context, moduleName, platform)
}

module.exports = config
