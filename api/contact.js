// POST /api/contact
// Delivers website leads to Adam by email via Resend.
//
// This replaces the previous client-side handler, which validated the form,
// hid it, displayed "Message Received!" — and sent nothing anywhere. Every
// lead submitted through the old form was silently discarded.
//
// No npm dependency: Resend's REST API is called directly with fetch().

import { json, methodGuard } from './_lib.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

const FIELDS = [
  ['fname',    'First Name',        true],
  ['lname',    'Last Name',         false],
  ['phone',    'Phone',             false],
  ['email',    'Email',             true],
  ['intent',   "Looking To",        false],
  ['area',     'Area of Interest',  false],
  ['timeline', 'Timeline',          false],
  ['message',  'Additional Details', false],
];

const isEmail = v => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(String(v || '').trim());

/** Escape user input before it goes into the HTML email body. */
const esc = v => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function buildEmail(data) {
  const rows = FIELDS
    .filter(([k]) => String(data[k] ?? '').trim())
    .map(([k, label]) => `
      <tr>
        <td style="padding:10px 16px;border-bottom:1px solid #e5e9f0;color:#66707f;
                   font:600 11px/1.4 -apple-system,Segoe UI,sans-serif;
                   letter-spacing:.08em;text-transform:uppercase;white-space:nowrap;
                   vertical-align:top">${esc(label)}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #e5e9f0;color:#111;
                   font:400 15px/1.6 -apple-system,Segoe UI,sans-serif">
          ${esc(data[k]).replace(/\n/g, '<br>')}
        </td>
      </tr>`)
    .join('');

  const name = [data.fname, data.lname].filter(Boolean).join(' ').trim() || 'Website visitor';

  return {
    subject: `New lead: ${name}${data.intent ? ` — ${data.intent}` : ''}`,
    html: `<!doctype html>
<html><body style="margin:0;background:#f4f6fa;padding:32px 16px">
  <table role="presentation" cellpadding="0" cellspacing="0"
         style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;
                overflow:hidden;border:1px solid #dde3ed">
    <tr>
      <td style="background:#1C2B4A;padding:22px 24px">
        <p style="margin:0;color:#8FB0E6;font:600 11px/1 -apple-system,Segoe UI,sans-serif;
                  letter-spacing:.18em;text-transform:uppercase">New Website Lead</p>
        <p style="margin:6px 0 0;color:#fff;font:600 21px/1.3 Georgia,serif">${esc(name)}</p>
      </td>
    </tr>
    <tr><td><table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rows}</table></td></tr>
    <tr>
      <td style="padding:18px 24px;background:#fafbfd">
        ${data.email ? `<a href="mailto:${esc(data.email)}"
          style="display:inline-block;background:#4169A8;color:#fff;text-decoration:none;
                 padding:11px 22px;border-radius:3px;font:600 12px/1 -apple-system,Segoe UI,sans-serif;
                 letter-spacing:.08em;text-transform:uppercase">Reply to ${esc(name)}</a>` : ''}
        ${data.phone ? `<a href="tel:${esc(String(data.phone).replace(/[^\d+]/g, ''))}"
          style="display:inline-block;margin-left:8px;border:1px solid #c3cede;color:#1C2B4A;
                 text-decoration:none;padding:10px 22px;border-radius:3px;
                 font:600 12px/1 -apple-system,Segoe UI,sans-serif;letter-spacing:.08em;
                 text-transform:uppercase">Call</a>` : ''}
        <p style="margin:16px 0 0;color:#8a94a4;font:400 11px/1.5 -apple-system,Segoe UI,sans-serif">
          Submitted ${esc(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }))} PT
          via hfr.homes${data.page ? ` · ${esc(data.page)}` : ''}
        </p>
      </td>
    </tr>
  </table>
</body></html>`,
  };
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, 'POST')) return;

  const apiKey = process.env.RESEND_API_KEY;
  const to     = process.env.LEAD_TO_EMAIL   || 'adam@hfr.homes';

  // Resend verifies DOMAINS, not individual addresses — once a domain is
  // verified, any address on it can send. hfr.homes is NOT verified (adding a
  // second domain costs $20/mo, deliberately deferred), so the default sender is
  // the already-verified nexadigitallabs.ai. Reply-To is still set to the lead's
  // own address below, so replying from the inbox reaches the right person
  // regardless of which domain sent it.
  const from   = process.env.LEAD_FROM_EMAIL
              || 'Henderson Family Realty <website@nexadigitallabs.ai>';

  if (!apiKey) {
    return json(res, {
      ok: false,
      error: 'Email delivery is not configured yet. Please call or text 951-240-8126.',
    }, { sMaxAge: 0, swr: 0, status: 503 });
  }

  // Body may arrive pre-parsed (Vercel) or as a raw string.
  let data = req.body;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = {}; }
  }
  data = data || {};

  // Honeypot: a hidden field real users never see or fill. Bots fill everything.
  // Return a success shape so the bot doesn't learn it was caught.
  if (String(data.company || '').trim()) {
    return json(res, { ok: true }, { sMaxAge: 0, swr: 0 });
  }

  if (!String(data.fname || '').trim()) {
    return json(res, { ok: false, error: 'Please enter your first name.' },
      { sMaxAge: 0, swr: 0, status: 400 });
  }
  if (!isEmail(data.email)) {
    return json(res, { ok: false, error: 'Please enter a valid email address.' },
      { sMaxAge: 0, swr: 0, status: 400 });
  }

  // Cap field lengths so an oversized paste can't bloat the email.
  for (const [k] of FIELDS) {
    if (typeof data[k] === 'string') data[k] = data[k].slice(0, 4000);
  }

  const { subject, html } = buildEmail(data);

  try {
    const r = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        html,
        // Hitting reply in the inbox goes straight to the lead.
        reply_to: String(data.email).trim(),
      }),
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      throw new Error(`Resend ${r.status}: ${detail.slice(0, 300)}`);
    }

    return json(res, { ok: true }, { sMaxAge: 0, swr: 0 });
  } catch (err) {
    console.error('[contact] delivery failed:', err);
    return json(res, {
      ok: false,
      error: "Something went wrong sending your message. Please call or text Adam at 951-240-8126.",
      detail: String(err.message || err),
    }, { sMaxAge: 0, swr: 0, status: 502 });
  }
}
