export function readAppVersionPolicy(env = process.env) {
  const raw = Number(env.ANDROID_MIN_VERSION_CODE ?? 14);
  const minVersionCode = Number.isSafeInteger(raw) && raw >= 14 ? raw : 14;
  return {
    minVersion: '1.0.0',
    android: { minVersionCode, storeUrl: 'https://play.google.com/store/apps/details?id=com.turentu.app' },
  };
}
