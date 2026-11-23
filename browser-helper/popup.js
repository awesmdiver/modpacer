// The helper's own popup. Everything shown is plain text (textContent), never HTML.
const $ = (id) => document.getElementById(id);
const LL = ['https://www.loverslab.com/*'];
function say(t) { $('msg').textContent = t || ''; }
async function refresh() {
    const s = await chrome.runtime.sendMessage({ type: 'status' });
    $('dot').className = 'dot' + (s.paired && s.allowed ? ' ok' : '');
    $('stateText').textContent = s.paired ? (s.allowed ? 'Connected to ModPacer. LoversLab is allowed.' : 'Connected to ModPacer. LoversLab is not allowed yet.') : 'Not connected.';
    $('pairBox').style.display = s.paired ? 'none' : '';
    $('allow').style.display = s.allowed ? 'none' : '';
    $('check').style.display = s.paired ? '' : 'none';
    $('version').textContent = 'Helper version ' + s.version;
}
$('connect').onclick = async () => {
    say('');
    const r = await chrome.runtime.sendMessage({ type: 'pair', code: $('code').value });
    say(r.ok ? '' : (r.reason === 'no_modpacer' ? "ModPacer isn't running." : "ModPacer didn't accept that code. Make a new one in Settings."));
    $('code').value = '';
    await refresh();
};
$('allow').onclick = async () => { say(''); try { await chrome.permissions.request({ origins: LL }); } catch (e) { say("The browser didn't allow it."); } await refresh(); };
$('check').onclick = async () => { say(''); const r = await chrome.runtime.sendMessage({ type: 'check' }); say(r && r.reason === 'no_modpacer' ? "ModPacer isn't running." : ''); await refresh(); };
refresh();
