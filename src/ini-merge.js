// Structure-preserving ini editing -- ported from Install-DLSS5Feeder.ps1's Set-IniKey/Get-IniKey.
// Rewrites one line if the key already exists in the section, otherwise inserts it at the end of
// that section (creating the section if needed), and never touches anything else in the file --
// these are files ReShade itself and the user's presets also read and write, so a wholesale
// rewrite would lose anything else already in there.
//
// $Section '' means "before the first [section] header" -- ReShadePreset.ini's Techniques= line
// lives there.

function splitLines(text) {
  const lines = (text || '').split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function setIniKey(text, section, key, value) {
  const lines = splitLines(text);
  const keyRe = new RegExp('^' + escapeRegExp(key) + '\\s*=', 'i');
  let cur = '';
  let secStart = -1;
  let secEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const m = t.match(/^\[(.+)\]$/);
    if (m) {
      if (cur.toLowerCase() === section.toLowerCase() && secStart >= 0 && secEnd < 0) secEnd = i;
      cur = m[1];
      if (cur.toLowerCase() === section.toLowerCase()) secStart = i + 1;
      continue;
    }
    if (cur.toLowerCase() === section.toLowerCase() && keyRe.test(t)) {
      lines[i] = `${key}=${value}`;
      return lines.join('\r\n') + '\r\n';
    }
  }

  if (section === '' && secStart < 0) {
    secStart = 0;
    secEnd = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('[')) break;
      secEnd = i + 1;
    }
  }

  if (secStart >= 0) {
    if (secEnd < 0) secEnd = lines.length;
    let at = secEnd;
    while (at > secStart && lines[at - 1].trim() === '') at--;
    lines.splice(at, 0, `${key}=${value}`);
  } else {
    if (lines.length > 0) lines.push('');
    lines.push(`[${section}]`);
    lines.push(`${key}=${value}`);
  }
  return lines.join('\r\n') + '\r\n';
}

function getIniKey(text, section, key) {
  if (text == null) return null;
  const keyRe = new RegExp('^' + escapeRegExp(key) + '\\s*=\\s*(.*)$', 'i');
  let cur = '';
  for (const l of text.split(/\r?\n/)) {
    const t = l.trim();
    const m = t.match(/^\[(.+)\]$/);
    if (m) { cur = m[1]; continue; }
    if (cur.toLowerCase() === section.toLowerCase()) {
      const km = t.match(keyRe);
      if (km) return km[1];
    }
  }
  return null;
}

module.exports = { setIniKey, getIniKey };
