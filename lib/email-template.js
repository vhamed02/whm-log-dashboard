'use strict';
/**
 * Email renderer for digests and test mails.
 *
 * Email HTML is not web HTML. The constraints this template is written against:
 *  - Table-based layout with role="presentation". Outlook (Word engine) does not
 *    support flex/grid, and float/margin collapse unpredictably.
 *  - Inline styles on every element. Gmail strips <head><style> when a message is
 *    clipped or forwarded, so the <style> block is progressive enhancement only
 *    (responsive tweaks) and never carries anything load-bearing.
 *  - Full-bleed 100% shell. The usual email convention is a fixed ~600px centred
 *    column, but these are dense monospace log lines that benefit from the extra
 *    horizontal room, so the shell spans the viewport and the MSO ghost table is
 *    width="100%" to match (a 600px ghost would re-pin the column in Outlook).
 *  - No external assets of any kind: images are blocked by default in most
 *    clients, and a log alert must be fully readable with nothing loaded.
 *  - color-scheme meta pinned to light: Gmail/Outlook dark modes auto-invert
 *    colours and mangle severity signalling, so we opt out and control it.
 *  - A hidden preheader, because the inbox preview otherwise shows navigation
 *    text instead of what actually broke.
 *
 * Severity colours intentionally mirror the dashboard's light theme, so an alert
 * looks like the UI it came from.
 */

const SEV = {
  critical: { label: 'CRITICAL', fg: '#ffffff', bg: '#cf222e', tint: '#fff0ee', edge: '#ffcecb', text: '#8b1a1a' },
  error: { label: 'ERROR', fg: '#ffffff', bg: '#bc4c00', tint: '#fff4ec', edge: '#ffd8b5', text: '#8a3800' },
  warning: { label: 'WARNING', fg: '#3d2c00', bg: '#e3b341', tint: '#fff8e6', edge: '#f5e3a8', text: '#6b4e00' },
  info: { label: 'INFO', fg: '#ffffff', bg: '#0969da', tint: '#eef5ff', edge: '#cfe2ff', text: '#0a3069' },
};
const SEV_ORDER = { critical: 0, error: 1, warning: 2, info: 3 };

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'SFMono-Regular',Consolas,'Liberation Mono',Menlo,Courier,monospace";

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function sevOf(s) { return SEV[s] || SEV.info; }

/** Coloured count chips: the at-a-glance summary above the entries. */
function chips(counts) {
  const keys = Object.keys(counts).filter(k => counts[k]).sort((a, b) => SEV_ORDER[a] - SEV_ORDER[b]);
  if (!keys.length) return '';
  const cells = keys.map(k => {
    const c = sevOf(k);
    return `<td style="padding:0 8px 0 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td bgcolor="${c.tint}" style="background:${c.tint};border:1px solid ${c.edge};padding:8px 12px;">
          <span style="font-family:${FONT};font-size:18px;font-weight:700;color:${c.text};line-height:1;">${counts[k]}</span>
          <span style="font-family:${FONT};font-size:11px;font-weight:600;color:${c.text};letter-spacing:.06em;text-transform:uppercase;">&nbsp;${esc(k)}</span>
        </td>
      </tr></table></td>`;
  }).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${cells}</tr></table>`;
}

/**
 * Bulletproof "Open dashboard" call-to-action. VML roundrect for Outlook (Word
 * engine ignores border-radius and padded-anchor backgrounds), a padded anchor
 * everywhere else. Returns '' when no URL is configured so nothing renders.
 */
function ctaButton(url) {
  if (!url) return '';
  const safe = esc(url);
  return `<tr><td class="pad" style="padding:0 22px 20px 22px;">
    <!--[if mso]>
    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safe}" style="height:40px;v-text-anchor:middle;width:210px;" arcsize="15%" strokecolor="#0969da" fillcolor="#0969da">
    <w:anchorlock/><center style="color:#ffffff;font-family:${FONT};font-size:13px;font-weight:700;">Open Log Dashboard</center>
    </v:roundrect>
    <![endif]-->
    <!--[if !mso]><!-- -->
    <a href="${safe}" target="_blank" style="display:inline-block;background:#0969da;font-family:${FONT};font-size:13px;font-weight:700;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:6px;">Open Log Dashboard &rarr;</a>
    <!--<![endif]-->
  </td></tr>`;
}

/**
 * One log entry card: severity stripe, pill, occurrence count, source, one
 * representative sample, timestamps.
 *
 * An item is a GROUP of identical entries, not a single line — `sample` is one
 * example and `count` is how many times that message occurred. The badge spells
 * that out ("occurred 300 times") rather than showing a bare multiplier, because
 * an email is read out of context and "x300" next to a log line is ambiguous.
 */
function itemCard(it) {
  const c = sevOf(it.severity);
  const times = it.count > 1
    ? `first ${esc(fmtTime(it.first))} &middot; last ${esc(fmtTime(it.last))}`
    : esc(fmtTime(it.last));
  const countBadge = it.count > 1
    ? `<span style="font-family:${FONT};font-size:12px;font-weight:700;color:${c.text};background:${c.tint};border:1px solid ${c.edge};padding:2px 8px;">occurred ${it.count} times</span>`
    : '';
  return `<tr><td style="padding:0 0 12px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #dfe3e8;background:#ffffff;">
      <tr>
        <td width="4" bgcolor="${c.bg}" style="width:4px;background:${c.bg};font-size:0;line-height:0;">&nbsp;</td>
        <td style="padding:12px 14px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="padding:0 0 8px 0;">
              <span style="font-family:${FONT};font-size:10px;font-weight:700;color:${c.fg};background:${c.bg};padding:3px 7px;letter-spacing:.08em;">${c.label}</span>
              &nbsp;${countBadge}
              <span style="font-family:${FONT};font-size:11px;color:#6e7781;">&nbsp;${esc(it.source)}</span>
            </td>
          </tr></table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td bgcolor="#f6f8fa" style="background:#f6f8fa;border:1px solid #e6eaef;padding:10px 12px;font-family:${MONO};font-size:12px;line-height:1.55;color:#1f2328;word-break:break-word;">
              <pre style="margin:0;font-family:${MONO};font-size:12px;line-height:1.55;color:#1f2328;white-space:pre-wrap;word-break:break-word;">${esc(it.sample)}</pre>
            </td></tr>
          </table>
          <div style="font-family:${FONT};font-size:11px;color:#8c959f;padding-top:7px;">${times}</div>
        </td>
      </tr>
    </table>
  </td></tr>`;
}

/**
 * Render a full email document.
 *   kind      'digest' | 'test'
 *   items     [{ severity, sample, source, count, first, last }] (pre-sorted).
 *             One item per GROUP of identical entries: `sample` is a single
 *             representative example and `count` is its occurrence total.
 *   counts    { severity: total }
 *   notes     [string] appended under the entries (caps, omissions)
 */
function renderEmail({ kind, account, senderName, subject, windowLine, counts, items, notes = [], settings, cadence, intervalMs, dashboardUrl }) {
  const isTest = kind === 'test';
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const summaryLine = Object.keys(counts).filter(k => counts[k])
    .sort((a, b) => SEV_ORDER[a] - SEV_ORDER[b]).map(k => `${counts[k]} ${k}`).join(' · ') || 'no entries';

  const preheader = isTest
    ? `Test email — ${summaryLine} sampled from the latest logs for ${account}`
    : `${summaryLine} — ${account}`;

  const banner = isTest ? `<tr><td bgcolor="#eef5ff" style="background:#eef5ff;border-bottom:1px solid #cfe2ff;padding:11px 22px;">
      <span style="font-family:${FONT};font-size:10px;font-weight:700;color:#ffffff;background:#0969da;padding:3px 7px;letter-spacing:.08em;">TEST</span>
      <span style="font-family:${FONT};font-size:12px;color:#0a3069;">&nbsp;Delivery test. The entries below are real, sampled from the newest logs — but this was sent on demand, not on the account's digest schedule.</span>
    </td></tr>` : '';

  const notesHtml = notes.length
    ? `<tr><td style="padding:4px 0 0 0;font-family:${FONT};font-size:11px;color:#8c959f;">${notes.map(esc).join('<br>')}</td></tr>`
    : '';

  // `cadence` is a human phrase for this account's chosen digest period ("hour",
  // "6 hours", "day", "week", "30 days"). Fall back to the legacy minute count if
  // a caller still passes only intervalMs.
  const cadencePhrase = cadence || `${Math.round((intervalMs || 3600000) / 60000)} minutes`;
  const footNote = isTest
    ? `Real digests are sent every ${cadencePhrase}, and only when there is something to report.`
    : `Digest for the last ${cadencePhrase}. Quiet periods send no email.`;

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${esc(subject)}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style type="text/css">
  body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
  table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}
  img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none;}
  body{margin:0!important;padding:0!important;width:100%!important;}
  @media only screen and (max-width:620px){
    .shell{width:100%!important;}
    .pad{padding-left:14px!important;padding-right:14px!important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:#ffffff;">
<div style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="background:#ffffff;">
<tr><td align="center" style="padding:0;">
<!--[if mso]><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" class="shell" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#ffffff;">
  <tr><td bgcolor="#0d1117" style="background:#0d1117;padding:18px 22px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;">${esc(senderName || 'Log Dashboard')}</td>
      <td align="right" style="font-family:${FONT};font-size:11px;color:#8b949e;">${esc(fmtTime(Date.now()))}</td>
    </tr></table>
  </td></tr>
  ${banner}
  <tr><td class="pad" style="padding:22px 22px 10px 22px;">
    <div style="font-family:${FONT};font-size:12px;font-weight:600;color:#6e7781;letter-spacing:.06em;text-transform:uppercase;">Account</div>
    <div style="font-family:${FONT};font-size:22px;font-weight:700;color:#1f2328;padding-top:2px;">${esc(account)}</div>
    <div style="font-family:${FONT};font-size:12px;color:#6e7781;padding-top:4px;">${esc(windowLine)}</div>
  </td></tr>
  <tr><td class="pad" style="padding:8px 22px 18px 22px;">${chips(counts)}</td></tr>
  ${ctaButton(dashboardUrl)}
  <tr><td class="pad" style="padding:0 22px 6px 22px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${items.map(itemCard).join('')}
      ${notesHtml}
    </table>
  </td></tr>
  <tr><td bgcolor="#f6f8fa" style="background:#f6f8fa;border-top:1px solid #e6eaef;padding:14px 22px;">
    <div style="font-family:${FONT};font-size:11px;color:#6e7781;line-height:1.6;">
      ${esc(footNote)}<br />
      Watching <strong style="color:#1f2328;">${settings.files.length}</strong> file${settings.files.length === 1 ? '' : 's'} &middot;
      severities: <strong style="color:#1f2328;">${esc(settings.severities.join(', ') || 'none')}</strong> &middot;
      <strong style="color:#1f2328;">${total}</strong> entr${total === 1 ? 'y' : 'ies'} in this message &middot;
      Log Dashboard / ${esc(account)}
    </div>
  </td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;

  // Plain-text alternative. Not a fallback nobody reads: spam filters score
  // multipart messages that lack one, and terminal/accessibility clients use it.
  const bar = '='.repeat(60);
  const textItems = items.map(it => {
    const head = it.count > 1
      ? `[${it.severity.toUpperCase()}] occurred ${it.count} times  ${it.source}\nfirst ${fmtTime(it.first)} · last ${fmtTime(it.last)}\n(one example shown)`
      : `[${it.severity.toUpperCase()}]  ${it.source}\n${fmtTime(it.last)}`;
    return head + '\n' + it.sample.split('\n').map(l => '  ' + l).join('\n');
  }).join('\n\n' + '-'.repeat(60) + '\n\n');

  const text = [
    isTest ? "TEST EMAIL — sent on demand, not on the account's digest schedule." : null,
    isTest ? 'The entries below are real, sampled from the newest logs.' : null,
    isTest ? '' : null,
    bar,
    `ACCOUNT: ${account}`,
    `${summaryLine}`,
    windowLine,
    dashboardUrl ? `Open the dashboard: ${dashboardUrl}` : null,
    bar,
    '',
    textItems || '(no entries)',
    '',
    ...notes,
    '',
    bar,
    footNote,
    `Watching ${settings.files.length} file(s) · severities: ${settings.severities.join(', ') || 'none'}`,
  ].filter(l => l !== null).join('\n');

  return { html, text };
}

module.exports = { renderEmail, SEV, SEV_ORDER, fmtTime, esc };
