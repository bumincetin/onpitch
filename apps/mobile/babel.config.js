// babel.config.js
//
// babel-preset-expo already carries the expo-router plugin, the React JSX runtime and the
// `process.env.EXPO_PUBLIC_*` inlining transform, so nothing else belongs here. An extra plugin
// listed in the wrong order is the usual cause of a "Cannot read property of undefined" that
// appears only in a release build and never in development.

module.exports = function (api) {
  api.cache(true)
  return {
    presets: ['babel-preset-expo'],
  }
}
