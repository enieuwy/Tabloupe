I agree with v2’s direction, but I would **not ship it exactly as written**. The biggest remaining issue is that the plan still treats “saved context,” “temporary view,” “show all,” and “last trigger” as if they can fit into `activeContextId + activeTrigger`. They cannot. That will leak immediately in the popup, migration, Apple Focus-off behavior, and “Show only this group.”

## Highest-priority remaining risks

### 1. `activeContextId: null` is overloaded

Right now `null` means “Show all groups.” But the plan also wants transient single-group quick switches. A transient quick switch cannot be represented as `activeContextId = null`, because that is indistinguishable from “All groups visible.”

Do **not** patch this with ad hoc fields. Change the model now to an explicit active-view union:

```js
activeView:
  | { kind: "all" }
  | { kind: "context", contextId: string }
  | { kind: "transient", label: string, selectors: GroupSelector[], scope: "window"|"allWindows", windowId?: number }

lastActivation:
  { trigger: "manual"|"appleFocus"|"schedule"|"external", triggerId?: string, at: number }
```

Then `Show all` becomes a **real state**, not absence of state. That matters because “Show all” is a user command, not merely “nothing active.”

### 2. “Controlled by: Manual” is the wrong mental model

“Controlled by” implies an ongoing controller. Manual switching is not a controller; it is just the most recent cause. In v1, most users will have no automation, so “Controlled by: Manual” is noise. For Apple Focus users, it is actively misleading because manual override vs Apple Focus resume behavior is underspecified.

Use:

```text
Showing: Work
```

Then, only when useful:

```text
Switched by Apple Focus
Manual override
```

Or in diagnostics/options:

```text
Last switched: Manual
Last switched: Apple Focus · Work
```

In the popup, hide the trigger line unless there is an actual automatic binding configured or the current view was activated automatically.

### 3. Contexts still reference “groups,” but they are really selectors

`groups: string[]` is not a group list. It is a list of **title selectors** and **glob selectors**. That distinction matters because Firefox tab group IDs are not durable across restore: MDN notes that tab groups can persist across browser restarts, but a restored group’s `groupId` may differ from the original, and recommends identifying groups across restarts using other properties and tabs, not the ID alone. ([MDN Web Docs][1])

So title/glob matching is defensible, but the model should admit what it is:

```js
groupSelectors: [
  { type: "title", value: "Work" },
  { type: "glob", value: "Client *" }
]
```

Keeping `groups: string[]` is acceptable only as a compatibility layer. For v2, I would rename the stored field now. Otherwise you bake in ambiguity, especially for literal group names containing `*` or `?`.

### 4. Duplicate and renamed tab-group titles are still a product footgun

Title selectors are user-comprehensible, but they are not stable identity. The UI needs guardrails:

When two current tab groups share the same title, show a warning:

```text
Two groups named “Work” match this context.
```

When a saved selector matches nothing, show it muted:

```text
Work — no matching group right now
```

When a glob matches multiple groups, show the count:

```text
Client * — matches 4 groups
```

Do **not** silently “fix” these by auto-renaming or auto-deleting selectors. Treat selectors as user intent.

### 5. Activation will sometimes fail the “show only this context” promise

In Firefox, collapsing a group does not necessarily make every tab in that group disappear from view: if the active tab is in a group being collapsed, Firefox keeps the active tab visible and collapses only the inactive tabs. MDN documents this behavior for `tabGroups.update({ collapsed: true })`. ([MDN Web Docs][2])

So activation should include an active-tab handoff:

```js
activate view
  query current window active tab
  if active tab is in a group that will be collapsed:
    find first expanded/matching group in that window
    activate first tab in that group
  collapse/expand groups
  persist activeView + lastActivation
```

Without this, “Show only Work” can leave a Personal tab visible because it was active at the moment of switching.

### 6. Current-groups quick switches should not be hidden just because a group is “covered”

The plan says “current tab groups as quick switches for groups not already covered.” I would not do that. A group being covered by a saved context does not mean the user will not want a quick one-group view.

Show all current groups, but annotate them:

```text
Work        Saved in: Work
Client A    Saved in: Client Work
Scratch     Not saved
```

Actions:

```text
Show just this group
Save as context
Add to context…
```

If the popup has to be short, collapse this section once the user has saved contexts. Do not remove covered groups entirely.

### 7. Apple Focus-off semantics will overwrite manual choices unless you model ownership

The plan says Focus-off calls `activateContext(null, { trigger: "appleFocus" })`. That is too blunt.

Example failure:

1. Apple Focus activates Work.
2. User manually switches to Personal.
3. Apple Focus turns off.
4. Extension switches to Show all, destroying the user’s manual choice.

Correct rule:

```text
An automatic trigger may deactivate only the view it currently owns.
```

So store enough source identity:

```js
activeView = { kind: "context", contextId: "ctx_work" }
lastActivation = { trigger: "appleFocus", triggerId: "com.apple.focus.work", at: ... }
```

Then Focus-off for `com.apple.focus.work` may return to the fallback only if the current view was last activated by that same Apple Focus trigger. If the user manually switched since then, Focus-off is a no-op.

### 8. The popup is still at risk of becoming two products in one tiny surface

“Saved contexts + Show all + current groups + AI organizer + toggles + proposal review” is too much.

The popup should be one of these:

```text
Primary popup: Context switcher
Secondary panel/card: Organize tabs
```

Do not keep the current AI toggle/header pattern. The current popup is explicitly AI-first: `popup.html` has `<h1>AI Tab Groups</h1>`, a top-level AI enabled toggle, connection warning, AI summary, pin/auto toggles, proposal list, and AI buttons. The plan correctly demotes AI, but the implementation needs a hard cut, not just a reorder.

Recommended popup layout:

```text
Tab Contexts

Showing: Work

[All groups] [Work] [Personal] [Client A]

This window’s groups
  Work        [Show] [Save]
  Scratch     [Show] [Save]

Organize tabs…
Options
```

Clicking “Organize tabs…” can expand the AI UI or route to a second popup state. Do not render AI provider/toggle/proposal machinery until the user asks for it.

## Data model and migration pressure-test

### I would change the model to this

```js
schemaVersion: 2,

contexts: [
  {
    id: "ctx_a1b2",
    name: "Work",
    icon: "briefcase",
    color: "blue",
    groupSelectors: [
      { type: "title", value: "Work" },
      { type: "glob", value: "Client *" }
    ],
    triggers: {
      appleFocusIds: ["com.apple.focus.work"]
    },
    createdAt: 1782610000000,
    updatedAt: 1782610000000,
    migratedFrom?: {
      focusIds: ["com.apple.focus.work"]
    }
  }
],

activeView:
  | { kind: "all" }
  | { kind: "context", contextId: string }
  | { kind: "transient", label: string, selectors: GroupSelector[], scope: "window"|"allWindows", windowId?: number },

lastActivation:
  | { trigger: "manual", at: number }
  | { trigger: "appleFocus", triggerId: string, at: number }
  | { trigger: "schedule", triggerId: string, at: number }
  | { trigger: "external", triggerId: string, at: number },

automationFallback:
  { kind: "all" } | { kind: "context", contextId: string },

ignoredAppleFocusIds: string[],

legacyFocusMappingsBackup: object
```

I would **not** put `schedule` directly on the context yet. Schedule semantics are not settled, and storing a reserved nullable field buys almost nothing. A later `triggers.schedule` object can be added cleanly under `triggers`.

### Migration: auto-create, but merge identical title sets

The plan contradicts itself here. It says “create/merge a Context,” but also says that if two Apple IDs map to identical title sets, the author still gets distinct contexts. I would not do that.

If two Apple Focus IDs map to the same normalized selector set, create **one** context with multiple Apple bindings:

```js
{
  name: "Work",
  groupSelectors: [{ type: "title", value: "Work" }],
  triggers: {
    appleFocusIds: [
      "com.apple.focus.work",
      "com.apple.focus.deep-work"
    ]
  }
}
```

Two contexts with identical visibility are not safer. They create duplicate rows that do the same thing and confuse activation state.

Migration rules I would use:

```text
focusMappings[id] with non-empty array:
  migrate to a context.

focusMappings[id] with []:
  migrate to ignoredAppleFocusIds.
  Do not create a context.
  Do not nag.

focusCatalog entry with no mapping:
  do not create a context.
  show only in Integrations if recently/currently detected.

multiple focus IDs with identical normalized selector set:
  one context, multiple appleFocusIds.

multiple focus IDs with overlapping but not identical sets:
  separate contexts.

missing focusCatalog metadata:
  derive readable fallback name, but store migratedFrom.focusIds.
```

Also add an import summary in Options:

```text
Imported 4 contexts from your previous Apple Focus mappings.
Review imported contexts
```

No modal prompt. Auto-migration preserves behavior; prompting risks users skipping the import and thinking the extension broke.

### Title/glob references are acceptable, but only as selectors

The latent footgun is not “titles instead of IDs.” IDs are not durable enough. The real footgun is pretending selectors are concrete groups.

Fix with UI and naming:

```text
Context contains:
  Matching tab groups
  Group name selectors
  Exact names and patterns
```

Avoid copy like:

```text
Groups in this context
```

unless the UI shows live resolved groups separately from saved selectors.

## `activateContext` semantics

### Collapse/expand-by-selector is the right primitive

The core primitive is still sound:

```js
resolve active view -> build matcher -> query tab groups -> expand matches, collapse non-matches
```

Firefox’s `tabGroups` API gives you query/update primitives for group state; `tabGroups.update()` modifies collapse/title/color state, while `tabs.group()`/`tabs.ungroup()` handle creating/removing groups. ([MDN Web Docs][1])

But rename it from `activateContext` to something more general:

```js
activateView(view, { trigger })
```

Then saved contexts are one kind of view.

### “Show all” should be a real state

Yes: `Show all` should be persisted as:

```js
activeView = { kind: "all" }
lastActivation = { trigger: "manual", at }
```

Not `activeContextId = null`.

### Groups matching no context

On saved-context activation, groups that do not match the active context should collapse. That is the product.

But in Options, unmatched selectors should stay visible and editable. Do not delete them.

### New groups after activation

Do **not** silently enforce the active context as a live policy in v1. That becomes surprising when the user creates a new group and it immediately disappears.

Instead:

```text
Switching context applies to the groups that exist now.
New groups remain visible until you switch again.
```

For extension-created AI groups, add a targeted rule:

If AI creates groups while a saved context is active, offer:

```text
Add new groups to “Work” context
```

This replaces the old “Pin new groups to active Focus” concept. The current `aiPinToFocus` language must be renamed/shimmed; otherwise v2 will leak old Focus terminology directly into the new popup.

### Pinned, ungrouped, and privileged tabs

Pinned/ungrouped tabs are outside the context model. The extension collapses tab groups; it does not hide arbitrary tabs. Be explicit:

```text
Contexts collapse tab groups. Ungrouped and pinned tabs stay visible.
```

That line prevents a lot of user confusion.

### Private windows / non-normal windows

Activation should probably restrict itself to normal windows unless the extension is explicitly enabled for private browsing. Do not let context state imply total-browser control when private windows may not participate.

## Decisions on the five open questions

### 1. Schedule end / Focus-off behavior

Decision: **automatic deactivation returns to Show all by default, but only if the current view is still owned by that automatic trigger.**

Later you can add:

```js
automationFallback = { kind: "all" }
// or
automationFallback = { kind: "context", contextId: "ctx_default" }
```

Do not restore some implicit previous context. That sounds clever but becomes unpredictable.

Rules:

```text
Apple Focus on, bound:
  activate bound context, trigger=appleFocus, triggerId=focusId.

Apple Focus off:
  if current view was last activated by that same Apple Focus trigger:
    activate automationFallback, trigger=appleFocus.
  else:
    no-op.

Schedule starts:
  activate scheduled context.

Schedule ends:
  if current view is still owned by that schedule:
    activate automationFallback.
  else:
    no-op.
```

### 2. Single-group “Show only this”

Decision: **transient activation. No save required.**

But it must be represented explicitly:

```js
activeView = {
  kind: "transient",
  label: "Work",
  selectors: [{ type: "title", value: "Work" }],
  scope: "window",
  windowId
}
```

For the popup, I would scope quick switches to the current window. The section is labeled “This window’s groups,” so the action should not unexpectedly collapse groups in another window.

Saved contexts can remain browser-wide/global for v1.

### 3. Naming

Decision: **ship as “Tab Contexts.”**

Do not keep “Focus Tab Groups” as the user-facing name. “Focus” now means too many things: generic attention, Apple Focus, old implementation, and the extension brand. The whole rewrite is trying to escape that ambiguity.

Acceptable transitional pattern:

```text
Tab Contexts
formerly Focus Tab Groups
```

Use that in release notes, not in the popup title.

### 4. Defaults

Decision: **zero bundled contexts in v1.**

No dead defaults. No starter templates in the main flow. Maybe later add a secondary affordance in empty state:

```text
Create starter contexts…
```

But do not build that now. The zero-config value is current Firefox tab groups as quick switches.

### 5. Migration aggressiveness

Decision: **auto-create contexts from all non-empty existing `focusMappings`; do not prompt.**

Prompting is worse than auto-migration because the user already configured the old model. Preserve behavior.

But change the merge rule:

```text
Same normalized title/glob set => one context, multiple Apple Focus bindings.
```

Empty mappings become ignored Apple Focus IDs, not contexts. Catalog-only IDs do not become contexts.

## Corrected first-release scope

### Build now

1. **Schema + migration**

   * `schemaVersion`
   * `contexts[]`
   * `groupSelectors`
   * `activeView`
   * `lastActivation`
   * `automationFallback`
   * `ignoredAppleFocusIds`
   * read-only legacy backup
   * auto-migration from non-empty `focusMappings`

2. **Activation core**

   * `activateView(view, { trigger, triggerId })`
   * saved context activation
   * transient single-group activation
   * Show all
   * Apple Focus adapter
   * trigger ownership rule for Focus-off
   * active-tab handoff when collapsing the active group
   * diagnostics for partial failures

3. **Popup v1**

   * context switcher first
   * Show all
   * saved contexts
   * current window group quick switches
   * Save as context
   * AI collapsed behind “Organize tabs…”
   * no connection warning in primary view
   * no “Controlled by: Manual”

4. **Options v1**

   * context cards
   * selector chips
   * unmatched/multi-match indicators
   * save current window as context
   * save this group
   * secondary new empty context
   * Apple Focus integration card only as optional/collapsed automation

5. **AI terminology migration**

   * `aiPinToFocus` becomes “Add new groups to current context”
   * keep storage compatibility, but do not show “Focus” in the popup
   * hide/disable when no saved context is active

6. **Tests**

   * identical mapping merge
   * empty mapping ignored
   * transient view distinct from Show all
   * Focus-off no-op after manual override
   * active-tab handoff
   * unmatched selector display
   * popup has no daemon warning
   * AI does not auto-preview on popup open

### Defer

I would defer these:

* schedules
* external/Raycast UI
* starter templates
* drag-to-reassign chips between context cards
* multi-source precedence engine
* public helper/slim broadcaster unless you are actually ready to support it

Drag-to-reassign is nice, but not load-bearing. Add/remove chips is enough for first release.

### Is deferring schedules a mistake?

Not if the first-release thesis is:

```text
A shareable manual tab-context switcher, with optional macOS automation for people who install/configure the helper.
```

It **is** a mistake if the release copy claims cross-platform automation. Windows/Linux users will have no automation in v1. So either ship schedules or stop implying automation is part of the v1 value proposition.

My recommendation: defer schedules, but make the public copy manual-first.

## Popup-specific ruling

Yes, the proposed popup is overloaded unless AI becomes a collapsed/secondary surface.

Final hierarchy I would ship:

```text
Tab Contexts

Showing: Work
[Show all]

Saved contexts
  Work
  Personal
  Client A

This window’s groups
  Work        [Show] [Save]
  Scratch     [Show] [Save]

Organize tabs…
Options
```

Conditional behavior:

* If there are no saved contexts, expand “This window’s groups.”
* If there are saved contexts, keep “This window’s groups” short or collapsible.
* If AI is clicked, enter an “Organize tabs” subview/card.
* Do not show AI provider settings in the popup.
* Do not show helper connection status in the popup except inside the AI subview when the selected AI provider actually requires the helper.
* Do not show `Controlled by: Manual`.

For Apple Focus users:

```text
Showing: Work
Switched by Apple Focus
```

After manual override:

```text
Showing: Personal
Manual override
```

But only show that if an Apple Focus binding exists. Otherwise it is just clutter.

## Naming and copy line-edits

### Manifest name

```json
"name": "Tab Contexts"
```

### Manifest description

Replace:

```text
Collapses and expands Firefox tab groups based on macOS Focus mode via mac-command-centre.
```

With:

```text
Save and switch Firefox tab-group contexts. Collapse the groups you do not need; tabs stay open. Optional macOS Focus automation.
```

I prefer “collapse” over “show only” because pinned, ungrouped, and active tabs can still be visible.

### Browser action title

```json
"default_title": "Switch tab context"
```

or simply:

```json
"default_title": "Tab Contexts"
```

### Popup title

```text
Tab Contexts
```

Not:

```text
AI Tab Groups
```

### Active indicator

Use:

```text
Showing: Work
```

For all groups:

```text
Showing: All groups
```

Avoid:

```text
Controlled by: Manual
```

For automation:

```text
Switched by Apple Focus
```

or:

```text
Following Apple Focus: Work
```

Only use “Following” if future Apple Focus changes will continue to drive the view.

### Show all button

```text
Show all groups
```

or shorter:

```text
All groups
```

### Current groups section

```text
This window’s groups
```

Actions:

```text
Show just this group
Save as context
Add to context…
```

Avoid:

```text
Show only this
```

because it overpromises if pinned/ungrouped tabs stay visible.

### Empty state

Current plan is close. I would use:

```text
Tab Contexts works with Firefox tab groups. Create a tab group in Firefox, or use Organize tabs to group this window.
```

Button:

```text
Organize tabs
```

### Options header

Replace:

```text
Map raw Apple Focus identifiers to the exact Firefox tab group titles you want expanded.
```

With:

```text
Save views of your Firefox tab groups. Switching a context expands matching groups and collapses the rest.
```

### Contexts section

```text
Contexts
Save the group names and patterns that belong together.
```

For selector chips:

```text
Matching groups
```

or:

```text
Group name selectors
```

Not just:

```text
Groups
```

### Apple Focus / Integrations card

Use:

```text
Automation
```

Card title:

```text
Apple Focus integration
```

Body:

```text
Optional. Manual switching works without any helper. On macOS, a local helper can switch contexts when Apple Focus changes.
```

Status labels:

```text
Helper connected
No helper connected
Reconnecting
```

Avoid:

```text
Not installed
```

The extension generally cannot know whether the helper is not installed, not running, blocked, or using a different port.

Binding copy:

```text
Detected Apple Focus modes
Bind a Focus mode to a context.
```

Unbound state:

```text
No Apple Focus modes detected yet.
```

### AI copy

Replace:

```text
Pin new groups to active Focus
```

With:

```text
Add new groups to current context
```

If active context exists:

```text
Add new groups to “Work”
```

If no saved context is active:

```text
Choose a saved context to add new groups to it.
```

## Bottom line

v2 is directionally right, but the shape is still too close to the old Focus-driven implementation. The necessary corrections are:

1. Replace `activeContextId + activeTrigger` with `activeView + lastActivation`.
2. Treat saved context group membership as **selectors**, not group identity.
3. Make single-group quick switches transient and current-window scoped.
4. Make Apple Focus-off respect manual override.
5. Hide “Controlled by Manual.”
6. Collapse AI into a secondary popup surface.
7. Auto-migrate old mappings, but merge identical title sets and ignore empty mappings.
8. Do not imply cross-platform automation until schedules or external triggers actually ship.

With those changes, the first release is coherent: a manual tab-context switcher that preserves the author’s Apple Focus workflow without making every new user stare at the author’s private automation stack.

[1]: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabGroups?utm_source=chatgpt.com "tabGroups - Mozilla - MDN Web Docs"
[2]: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabGroups/update?utm_source=chatgpt.com "tabGroups.update - Mozilla - MDN Web Docs"
