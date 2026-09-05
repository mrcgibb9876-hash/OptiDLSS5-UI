// Where the Feeder toolchain's pieces come from -- ported from Install-DLSS5Feeder.ps1's own
// $Sources table. Edit here when a link moves. Deep Fried Chicken is deliberately absent: its real
// source is a Discord CDN link that expires and isn't ours to redistribute, so (like
// nvngx_dlssnr.dll elsewhere in this app) it stays a user-supplied local zip via Settings rather
// than an automated download.
module.exports = {
  FEEDER_RELEASES_API: 'https://api.github.com/repos/jlrouzies-fr/DLSS5-Feeder/releases',
  FEEDER_ASSET_PATTERN: /^DLSS5-Feeder-.*\.zip$/i,

  RESHADE_SETUP_URL: 'https://reshade.me/downloads/ReShade_Setup_6.8.0_Addon.exe',

  LUMENITE_ZIP_URL: 'https://codeload.github.com/umar-afzaal/LumeniteFX/zip/refs/heads/mainline',

  RESHADE_HEADERS: {
    'ReShade.fxh': 'https://raw.githubusercontent.com/crosire/reshade-shaders/slim/Shaders/ReShade.fxh',
    'ReShadeUI.fxh': 'https://raw.githubusercontent.com/crosire/reshade-shaders/slim/Shaders/ReShadeUI.fxh',
    'DrawText.fxh': 'https://raw.githubusercontent.com/crosire/reshade-shaders/slim/Shaders/DrawText.fxh'
  }
};
