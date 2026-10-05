'use strict';
// The FOMOD screen: options on the left (compact checkboxes and radios, one short line each), and on the right the
// preview image plus the description of the option the pointer is over. Ported from vortex-collection-tools' own
// web/public/fomod-picker.js (same author), whose step logic was checked against Vortex's real FOMOD wizard
// (InstallerDialog.tsx, XmlScriptExecutor.cs). Keep the two in step -- see TECHNICAL.md. What differs here, on purpose:
//   - one mod at a time (this app's "Update all" opens the screen once per FOMOD mod, so there is no mod queue),
//   - no "invalid installer" screen (this app has no schema-validation gate), no reinstall/intro/no-data notes,
//   - a Skip this one button for the batch, which replaces Cancel there,
//   - the description also follows keyboard focus, and re-shows after you pick something (the sister clears it),
//   - no extra labels: a ticked box already shows last time's pick (the sister marks it "(Preset)", dropped here),
//   - classes and ids are named for this app (fp-*, fomodPicker*) and use this app's theme variables.
//
// Public API: showFomodPicker(need, { title, batch, onDone, onCancel, onSkip }).
//   need: { modId, reason: 'open'|'mismatch', parsedFomod, existingChoices?, installedFileState, imageCacheToken? } --
//     the shape POST /api/plugins/:id/wizard answers with (lib/vortex-update.js prepareFomodWizard). 'mismatch' means
//     there are recorded choices: whatever still matches by name is pre-picked (no label). 'open' means nothing was
//     recorded: Recommended options are pre-picked, the way Vortex does.
//   onDone(picks): the player pressed Finish. picks = { [stepIdx]: { [groupIdx]: number[] } } (plugin indices).
//   onCancel(): closed (X or Cancel) in a single update. onSkip(): Skip this one (or X) in an Update all batch.
//   The modal is hidden before any callback runs.

const FP_PLUGIN_EXT_RE = /\.(esp|esm|esl)(\.ghost)?$/i;

// ---- pure step logic (no DOM; the tests load this file in node) ----

// installedFileState arrives as plain arrays (JSON); turned into Sets once so a fileDependency is an O(1) lookup.
// This app does not know what is installed ({available:false}), so a fileDependency counts as "not matched" -- the
// honest fallback (under-select rather than guess).
function fomodPrepareInstalledFileState(need) {
    const fs = need.installedFileState;
    if (fs && fs.available && !fs.presentSet) {
        fs.presentSet = new Set(fs.present || []);
        fs.activeSet = new Set(fs.active || []);
    }
}

function fomodFileDependencyMatches(dep, fileState) {
    if (!fileState || !fileState.available) return false;
    const key = (dep.file || '').trim().toLowerCase();
    if (!FP_PLUGIN_EXT_RE.test(key)) return dep.state === 'Missing';
    const present = fileState.presentSet.has(key);
    const active = fileState.activeSet.has(key);
    if (dep.state === 'Active') return present && active;
    if (dep.state === 'Inactive') return present && !active;
    if (dep.state === 'Missing') return !present;
    return false;
}

// A composite condition (a step's <visible>, or a type pattern's <dependencies>). An EMPTY And is true, an EMPTY Or is
// false -- exactly what every()/some() give, and what the real engine does (CompositeCondition.cs).
function fomodEvalCondition(cond, flags, fileState) {
    if (!cond) return true;
    const results = [
        ...(cond.flagDependencies || []).map((d) => (flags.get(d.flag) ?? '') === d.value),
        ...(cond.fileDependencies || []).map((d) => fomodFileDependencyMatches(d, fileState)),
        ...(cond.gameDependencies || []).map(() => true),
        ...(cond.extenderDependencies || []).map(() => true),
        ...(cond.nested || []).map((c) => fomodEvalCondition(c, flags, fileState)),
    ];
    return cond.operator === 'Or' ? results.some(Boolean) : results.every(Boolean);
}

// First matching pattern wins, else the default type (ConditionalOptionTypeResolver.ResolveOptionType). A recorded
// pick that would be NotUsable is promoted to CouldBeUsable so it can still be unticked (Vortex's own preselectOptions).
function fomodResolveType(typeDescriptor, flags, fileState, isPresetMatch) {
    let type = 'Optional';
    if (typeDescriptor) {
        type = typeDescriptor.default || 'Optional';
        for (const p of typeDescriptor.patterns || []) {
            if (fomodEvalCondition(p.condition, flags, fileState)) { type = p.type; break; }
        }
    }
    return (isPresetMatch && type === 'NotUsable') ? 'CouldBeUsable' : type;
}

// The real fixSteps(): a SelectAtMostOne with 2+ Required options becomes SelectAny; a SelectExactlyOne with 2+
// Required becomes SelectAtLeastOne (an exclusive group can't hold two mandatory options). Run once per mod, with no flags.
function fomodFixGroupTypes(need) {
    const emptyFlags = new Map();
    need.parsedFomod.installSteps.forEach((step) => {
        step.groups.forEach((group) => {
            if (group.type !== 'SelectAtMostOne' && group.type !== 'SelectExactlyOne') return;
            const requiredCount = group.plugins.filter(
                (p) => fomodResolveType(p.typeDescriptor, emptyFlags, need.installedFileState) === 'Required'
            ).length;
            if (requiredCount <= 1) return;
            group.type = group.type === 'SelectAtMostOne' ? 'SelectAny' : 'SelectAtLeastOne';
        });
    });
}

function fomodAddGroupFlags(flags, group, selectedIndices) {
    const selected = group.type === 'SelectAll' ? group.plugins.map((_, idx) => idx) : (selectedIndices || []);
    selected.forEach((idx) => {
        const plugin = group.plugins[idx];
        if (!plugin) return;
        (plugin.conditionFlags || []).forEach((f) => flags.set(f.name, f.value));
    });
}

// Flags set by every group answered STRICTLY BEFORE (stepIdx, groupIdx); groupIdx undefined = the whole of stepIdx's
// predecessors. Rebuilt every call, so changing an earlier answer un-sets what the old pick had set.
function fomodFlagsUpTo(need, answers, stepIdx, groupIdx) {
    const flags = new Map();
    const steps = need.parsedFomod.installSteps;
    for (let s = 0; s < stepIdx && s < steps.length; s++) {
        const stepAnswers = answers[s] || {};
        steps[s].groups.forEach((group, gi) => fomodAddGroupFlags(flags, group, stepAnswers[gi]));
    }
    if (groupIdx !== undefined && steps[stepIdx]) {
        const stepAnswers = answers[stepIdx] || {};
        for (let g = 0; g < groupIdx; g++) fomodAddGroupFlags(flags, steps[stepIdx].groups[g], stepAnswers[g]);
    }
    return flags;
}

function fomodComputeStepVisibility(need, answers) {
    return need.parsedFomod.installSteps.map((step, i) => fomodEvalCondition(step.visible, fomodFlagsUpTo(need, answers, i), need.installedFileState));
}

// The names recorded for this step + group last time (steps matched by position, groups by trimmed name -- the same
// convention choice-resolver.js uses). Empty for a fresh FOMOD.
function fomodPresetNames(need, stepIdx, groupIdx) {
    if (!need.existingChoices || !need.existingChoices.options) return new Set();
    const recordedStep = need.existingChoices.options[stepIdx];
    if (!recordedStep) return new Set();
    const step = need.parsedFomod.installSteps[stepIdx];
    const groupNameTrimmed = (step.groups[groupIdx].name || '').trim();
    const recordedGroup = (recordedStep.groups || []).find((g) => (g.name || '').trim() === groupNameTrimmed);
    if (!recordedGroup) return new Set();
    return new Set((recordedGroup.choices || []).map((c) => (c.name || '').trim()));
}

// The first-visit picks for one step, matching the real preselectOptions(): Required options, options recorded last
// time (by name), and Recommended ones only when nothing was recorded at all ('open'). In a radio group several
// qualifying options leave the LAST one picked; a SelectExactlyOne with nothing picked falls back to its first option.
// Writes into answers[stepIdx] and returns it.
function fomodInitialStepAnswers(need, stepIdx, answers) {
    const step = need.parsedFomod.installSteps[stepIdx];
    answers[stepIdx] = answers[stepIdx] || {};
    step.groups.forEach((group, groupIdx) => {
        if (group.type === 'SelectAll') return;
        const flags = fomodFlagsUpTo(need, answers, stepIdx, groupIdx);
        const presetNames = fomodPresetNames(need, stepIdx, groupIdx);
        const isRadio = group.type === 'SelectExactlyOne' || group.type === 'SelectAtMostOne';
        const forced = [];
        group.plugins.forEach((plugin, idx) => {
            const isPreset = presetNames.has((plugin.name || '').trim());
            const type = fomodResolveType(plugin.typeDescriptor, flags, need.installedFileState, isPreset);
            if (type === 'Required' || isPreset || (need.reason === 'open' && type === 'Recommended')) forced.push(idx);
        });
        if (!isRadio) answers[stepIdx][groupIdx] = forced;
        else if (forced.length > 0) answers[stepIdx][groupIdx] = [forced[forced.length - 1]];
        else if (group.type === 'SelectExactlyOne' && group.plugins.length > 0) answers[stepIdx][groupIdx] = [0];
        else answers[stepIdx][groupIdx] = [];
    });
    return answers[stepIdx];
}

// Refuses to advance when a group's rule isn't met (SelectExactlyOne needs one, SelectAtLeastOne needs one,
// SelectAtMostOne allows one). Returns the message, or null.
function fomodValidateStep(need, stepIdx, answers) {
    const step = need.parsedFomod.installSteps[stepIdx];
    const stepAnswers = answers[stepIdx] || {};
    for (let groupIdx = 0; groupIdx < step.groups.length; groupIdx++) {
        const group = step.groups[groupIdx];
        if (group.type === 'SelectAll') continue;
        const indices = stepAnswers[groupIdx] || [];
        if (group.type === 'SelectExactlyOne' && indices.length !== 1) return `"${step.name}" / "${group.name}" needs exactly one pick.`;
        if (group.type === 'SelectAtLeastOne' && indices.length < 1) return `"${step.name}" / "${group.name}" needs at least one pick.`;
        if (group.type === 'SelectAtMostOne' && indices.length > 1) return `"${step.name}" / "${group.name}" allows at most one pick.`;
    }
    return null;
}

// The visible steps around stepIdx: { prev, next } step indices, -1 when there is none.
function fomodNeighbourSteps(need, answers, stepIdx) {
    const steps = need.parsedFomod.installSteps;
    const visibility = fomodComputeStepVisibility(need, answers);
    let prev = -1;
    for (let i = 0; i < stepIdx; i++) if (visibility[i]) prev = i;
    let next = -1;
    for (let i = stepIdx + 1; i < steps.length; i++) { if (visibility[i]) { next = i; break; } }
    return { prev, next };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        fomodPrepareInstalledFileState, fomodFileDependencyMatches, fomodEvalCondition, fomodResolveType, fomodFixGroupTypes,
        fomodFlagsUpTo, fomodComputeStepVisibility, fomodPresetNames, fomodInitialStepAnswers, fomodValidateStep, fomodNeighbourSteps,
    };
}

// ---- the screen (browser only) ----
if (typeof document !== 'undefined') {
    (function () {
        let need = null;
        let opts = {};
        let stepIdx = 0;
        let answers = {};         // {[stepIdx]: {[groupIdx]: number[]}}
        let initedSteps = new Set();
        let lastStepKey = null;   // tells "entered a new step" apart from "toggled an option in this step"
        let lastPreview = null;   // {groupIdx, idx} of the option whose description is showing
        let prevStepIdx = -1;
        let nextStepIdx = -1;

        const $g = (id) => document.getElementById(id);
        const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

        window.showFomodPicker = function showFomodPicker(newNeed, options) {
            need = newNeed;
            opts = options || {};
            fomodPrepareInstalledFileState(need);
            fomodFixGroupTypes(need);
            stepIdx = 0;
            answers = {};
            initedSteps = new Set();
            lastStepKey = null;
            lastPreview = null;
            const batch = !!opts.batch;
            $g('fomodPickerSkip').style.display = batch ? '' : 'none';
            $g('fomodPickerCancel').style.display = batch ? 'none' : '';
            $g('fomodPickerModal').classList.add('open');
            renderStep();
        };

        function close() { $g('fomodPickerModal').classList.remove('open'); closeZoom(); }

        // Real DOM nodes with real listeners, not innerHTML with inline attributes: an option called "JK's Castle Dour" has an apostrophe.
        // A Required option is checked and inert but not greyed (Vortex's readOnly): the click is cancelled. NotUsable and
        // the always-installed SelectAll rows really are disabled (dimmed), a different look on purpose.
        function buildOptionRow({ id, inputType, name, value, checked, disabled, readOnly, label, title, onChange }) {
            const row = document.createElement('label');
            row.className = `fp-option${disabled ? ' is-disabled' : ''}`;
            row.htmlFor = id;
            if (title) row.title = title;
            const input = document.createElement('input');
            input.type = inputType;
            input.id = id;
            input.name = name;
            input.value = value;
            input.checked = checked;
            input.disabled = disabled;
            if (readOnly) input.addEventListener('click', (e) => e.preventDefault());
            else input.addEventListener('change', onChange);
            row.appendChild(input);
            const span = document.createElement('span');
            span.textContent = label;
            row.appendChild(span);
            return row;
        }

        function wirePreview(row, plugin, groupIdx, idx) {
            const show = () => showPreview(plugin, row, { groupIdx, idx });
            row.addEventListener('mouseenter', show);
            row.addEventListener('focusin', show);
        }

        function buildGroupEl(stepI, group, groupIdx) {
            const groupEl = document.createElement('div');
            groupEl.className = 'fp-group';
            const nameEl = document.createElement('div');
            nameEl.className = 'fp-group-name';
            nameEl.textContent = group.name;
            if (group.type === 'SelectExactlyOne' || group.type === 'SelectAtLeastOne') {
                const req = document.createElement('span');
                req.className = 'fp-group-required';
                req.textContent = ' (required)';
                nameEl.appendChild(req);
            }
            groupEl.appendChild(nameEl);
            const inputName = `fomodpicker-s${stepI}-g${groupIdx}`;

            if (group.type === 'SelectAll') {
                group.plugins.forEach((plugin, idx) => {
                    const row = buildOptionRow({
                        id: `${inputName}-${idx}`, inputType: 'checkbox', name: inputName, value: String(idx),
                        checked: true, disabled: true, label: plugin.name, title: 'Always installed', onChange: () => {},
                    });
                    wirePreview(row, plugin, groupIdx, idx);
                    groupEl.appendChild(row);
                });
                return groupEl;
            }

            const isRadio = group.type === 'SelectExactlyOne' || group.type === 'SelectAtMostOne';
            const flags = fomodFlagsUpTo(need, answers, stepI, groupIdx);
            const presetNames = fomodPresetNames(need, stepI, groupIdx);
            const selected = new Set((answers[stepI] && answers[stepI][groupIdx]) || []);

            // A real "(None)" radio, so zero picks in a SelectAtMostOne group can be expressed.
            if (group.type === 'SelectAtMostOne') {
                groupEl.appendChild(buildOptionRow({
                    id: `${inputName}-none`, inputType: 'radio', name: inputName, value: '-1',
                    checked: selected.size === 0, disabled: false, label: '(None)',
                    onChange: () => onSelect(stepI, groupIdx, []),
                }));
            }

            group.plugins.forEach((plugin, idx) => {
                const isPreset = presetNames.has((plugin.name || '').trim());
                const rawType = fomodResolveType(plugin.typeDescriptor, flags, need.installedFileState);
                const wasPromotedFromNotUsable = isPreset && rawType === 'NotUsable';
                const type = wasPromotedFromNotUsable ? 'CouldBeUsable' : rawType;
                const isRequired = type === 'Required';
                const isNotUsable = type === 'NotUsable';
                const row = buildOptionRow({
                    id: `${inputName}-${idx}`,
                    inputType: isRadio ? 'radio' : 'checkbox',
                    checked: isRequired || selected.has(idx),
                    name: inputName,
                    value: String(idx),
                    disabled: isNotUsable,
                    readOnly: isRequired,
                    label: plugin.name,
                    title: isNotUsable
                        ? 'Not available with your other current picks'
                        : isRequired
                            ? 'Required -- always installed'
                            : wasPromotedFromNotUsable
                                ? 'Your original pick — it may not fit your current setup, but you can keep it or choose something else.'
                                : undefined,
                    onChange: () => {
                        let next;
                        if (isRadio) next = [idx];
                        else {
                            const cur = new Set((answers[stepI] && answers[stepI][groupIdx]) || []);
                            if (cur.has(idx)) cur.delete(idx); else cur.add(idx);
                            next = [...cur];
                        }
                        onSelect(stepI, groupIdx, next);
                    },
                });
                wirePreview(row, plugin, groupIdx, idx);
                groupEl.appendChild(row);
            });
            return groupEl;
        }

        // A pick can change other options' types or a later step's visibility, so the step is redrawn on every change.
        function onSelect(stepI, groupIdx, next) {
            answers[stepI] = answers[stepI] || {};
            answers[stepI][groupIdx] = next;
            renderStep();
        }

        // The right-hand panel. Hover (or keyboard focus) driven, as in Vortex. A plugin with no <image> shows no picture
        // box at all; one whose file is missing from the archive just shows the browser's broken-image glyph, as Vortex does.
        function showPreview(plugin, rowEl, at) {
            document.querySelectorAll('#fomodPickerOptions .fp-option.is-active').forEach((r) => r.classList.remove('is-active'));
            if (rowEl) rowEl.classList.add('is-active');
            lastPreview = at || null;
            const el = $g('fomodPickerPreview');
            if (!plugin) {
                el.innerHTML = '<div class="fp-preview-empty">Hover over an option to see its image and description.</div>';
                return;
            }
            const imgSrc = plugin.image && need && need.modId
                ? `/api/fomod-image?modId=${encodeURIComponent(need.modId)}&imagePath=${encodeURIComponent(plugin.image)}`
                : null;
            const imgHtml = imgSrc ? `<div class="fp-preview-image"><img src="${esc(imgSrc)}" alt=""></div>` : '';
            const descHtml = plugin.description ? `<div class="fp-preview-desc">${esc(plugin.description)}</div>` : '';
            el.innerHTML = imgHtml + descHtml;
            if (imgSrc) {
                const imgEl = el.querySelector('.fp-preview-image img');
                if (imgEl) imgEl.addEventListener('click', () => openZoom(imgSrc));
            }
        }

        function zoomEscape(e) { if (e.key === 'Escape') closeZoom(); }
        function openZoom(src) {
            $g('fomodZoomImage').src = src;
            $g('fomodZoomOverlay').classList.add('open');
            document.addEventListener('keydown', zoomEscape, true);
        }
        function closeZoom() {
            $g('fomodZoomOverlay').classList.remove('open');
            document.removeEventListener('keydown', zoomEscape, true);
        }
        $g('fomodZoomOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeZoom(); });

        function renderStep() {
            const steps = need.parsedFomod.installSteps;
            const step = steps[stepIdx];
            $g('fomodPickerTitle').textContent = opts.title || need.parsedFomod.moduleName || 'FOMOD install options';
            $g('fomodPickerTitle').title = $g('fomodPickerTitle').textContent; // cut with an ellipsis when long: the full name on hover
            $g('fomodPickerStepName').textContent = step.name;
            $g('fomodPickerError').classList.add('hidden');

            const key = `0:${stepIdx}`;
            if (!initedSteps.has(key)) { initedSteps.add(key); fomodInitialStepAnswers(need, stepIdx, answers); }

            // Only a genuine step change scrolls back to the top; toggling an option keeps your place.
            const optionsEl = $g('fomodPickerOptions');
            const preservedScrollTop = optionsEl.scrollTop;
            const isSameStep = lastStepKey === key;
            optionsEl.innerHTML = '';
            step.groups.forEach((group, groupIdx) => optionsEl.appendChild(buildGroupEl(stepIdx, group, groupIdx)));
            optionsEl.scrollTop = isSameStep ? preservedScrollTop : 0;
            lastStepKey = key;

            // After a pick the panel keeps showing the option you were on; on a new step it starts empty.
            const keep = isSameStep && lastPreview;
            const keepGroup = keep && step.groups[lastPreview.groupIdx];
            const keepPlugin = keepGroup && keepGroup.plugins[lastPreview.idx];
            if (keepPlugin) {
                const inputName = `fomodpicker-s${stepIdx}-g${lastPreview.groupIdx}`;
                const input = document.getElementById(`${inputName}-${lastPreview.idx}`);
                showPreview(keepPlugin, input ? input.closest('.fp-option') : null, lastPreview);
            } else {
                showPreview(null);
            }

            const nb = fomodNeighbourSteps(need, answers, stepIdx);
            prevStepIdx = nb.prev;
            nextStepIdx = nb.next;
            const backBtn = $g('fomodPickerBack');
            backBtn.style.display = prevStepIdx === -1 ? 'none' : '';
            if (prevStepIdx !== -1) { backBtn.textContent = steps[prevStepIdx].name; backBtn.title = steps[prevStepIdx].name; }
            const nextLabel = nextStepIdx === -1 ? 'Finish' : steps[nextStepIdx].name;
            $g('fomodPickerNext').textContent = nextLabel;
            $g('fomodPickerNext').title = nextLabel; // the full name, for when a long one is cut with an ellipsis
            // Real formula from Vortex: ProgressBar now={idx} max={steps.length-1}.
            $g('fomodPickerProgressFill').style.width = `${Math.round((stepIdx / Math.max(steps.length - 1, 1)) * 100)}%`;
        }

        $g('fomodPickerBack').addEventListener('click', () => {
            if (prevStepIdx === -1) return;
            stepIdx = prevStepIdx;
            renderStep();
        });

        $g('fomodPickerNext').addEventListener('click', () => {
            const error = fomodValidateStep(need, stepIdx, answers);
            if (error) {
                const err = $g('fomodPickerError');
                err.innerHTML = `<div class="callout__title">⚠️ Can't advance this step</div><p>${esc(error)}</p>`;
                err.classList.remove('hidden');
                return;
            }
            if (nextStepIdx !== -1) { stepIdx = nextStepIdx; renderStep(); return; }
            const picks = answers;
            const onDone = opts.onDone;
            close();
            if (onDone) onDone(picks);
        });

        function leave(callbackName) {
            const cb = opts[callbackName];
            close();
            if (cb) cb();
        }
        $g('fomodPickerCancel').addEventListener('click', () => leave('onCancel'));
        $g('fomodPickerSkip').addEventListener('click', () => leave('onSkip'));
        // The X: Cancel in a single update, Skip this one in an Update all batch (a batch has no Cancel).
        $g('fomodPickerClose').addEventListener('click', () => leave(opts.batch ? 'onSkip' : 'onCancel'));
    })();
}
