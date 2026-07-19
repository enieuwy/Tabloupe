## Top-line verdict

The strategic direction is right: **make the browser feature independent of macOS Focus**, and treat macOS/Raycast/CLI/schedule as triggers for the same tab-group narrowing behavior.

But I would **not ship the proposed merged-catalog design as-is**. The biggest danger is that you replace a single-user product with a product that is technically source-agnostic but mentally messy: defaults, tab groups, Apple Focus IDs, Raycast sessions, schedules, and AI grouping all competing under the word “Focus.”

The product should become:

> **A tab-group context switcher.**
> A “context” is a saved view of your Firefox tab groups. Triggers can switch contexts automatically.

That means: local contexts are first-class. Everything else is either a way to create a context or a way to activate one.

---

# 1. Biggest UX risks, prioritized

## 1. The merged catalog is the most dangerous part

Your proposal says:

> Catalog becomes a union: daemon-owned `focusCatalog` ∪ local/default catalog.

I would strongly avoid presenting that union directly in UI.

That creates immediate duplicate/confusing states:

* Default **Work**
* Existing tab group named **Work**
* macOS Focus named **Work**
* A saved mapping for raw ID `com.apple.focus.work`
* Maybe a Raycast script that also triggers `work`

A normal user should never have to understand why there are three “Work” rows.

The better model:

### Make **local contexts** the only visible first-class object

A context has:

* name: `Work`
* icon/color
* visible tab-group titles or patterns: `Work`, `GitHub`, `Docs`, `Client *`
* optional schedule
* optional trigger bindings

Then external things bind to that context:

* Apple Focus `com.apple.focus.work` → Context `Work`
* CLI alias `work` → Context `Work`
* Schedule weekday 9–5 → Context `Work`

So the user sees one row:

> **Work**
> Shows: Work, GitHub, Docs
> Triggers: Schedule, Apple Focus

Not three Work-like objects.

### Recommendation

Do **not** render “defaults + groups + OS IDs” as peer rows. Render **contexts** as rows. Render Apple Focus IDs, Raycast aliases, and schedules as **triggers/bindings attached to contexts**.

This is the single most important product correction.

---

## 2. Defaults are not enough for zero-config value

Bundling Work / Personal / Reading / Sleep / Do Not Disturb sounds friendly, but it may be hollow.

If I install the extension and I do **not** already have tab groups named `Work`, `Personal`, or `Reading`, clicking “Work” may do nothing useful or, worse, collapse everything unexpectedly. That is a terrible first-run experience.

Defaults only work if the user already thinks in your vocabulary. Most users’ groups will be things like:

* `Project Apollo`
* `Docs`
* `Shopping`
* `Research`
* `GitHub`
* `Client A`

The real zero-config value is not “we shipped five names.” The real zero-config value is:

> “You already have tab groups. Click one to show only that group. Save combinations when useful.”

### Recommendation

Use defaults as **templates or suggestions**, not primary active items.

The first-run popup should prioritize:

1. **Existing tab groups in this window**
2. **Saved contexts**
3. **Show all groups**
4. A lightweight creation action: “Save current groups as a context”

If there are no tab groups, the empty state should say something like:

> Focus Tab Groups works with Firefox tab groups. Create a few tab groups, or use Organize tabs to group this window.

Do not show five dead default contexts as if the product is already useful.

---

## 3. Killing “Create Focus” entirely hides a necessary primitive

I agree that a blank “＋ New Focus” modal is clunky. But removing creation completely is an overcorrection.

There are legitimate cases where creation is needed:

* I want a context containing several existing groups: `GitHub`, `Docs`, `Slack`
* I want to create `Client A` before all the groups exist
* I want a context that uses glob patterns
* I want a schedule target that is not just one group
* I want to migrate from Apple Focus IDs into my own local names
* I want a context whose name differs from any group title

The problem is not “creation exists.” The problem is **blank creation as the primary gesture**.

### Recommendation

Keep creation, but make the primary creation paths contextual:

* **Save current window’s groups as a context**
* **Save this group as a context**
* **Create context from selected groups**
* Secondary/advanced: **Create empty context**

So yes: avoid the blank modal as the main path. No: do not remove the primitive.

A good creation UI would be closer to:

> **New context**
> Name: Work
> Shows these tab groups: `[GitHub] [Docs] [Slack]`
> Optional: add schedule

That is not clunky. It is concrete.

---

## 4. The popup switcher is the right surface, but the current popup cannot simply absorb it

A popup switcher is absolutely the right surface for manual activation. If the extension is supposed to work with zero backend, the toolbar popup must let me switch contexts immediately.

But the current popup is **AI-first**. It literally titles itself “AI Tab Groups,” has an AI enabled toggle, auto-previews groups, and shows daemon connection warnings. Adding a context switcher into that UI without rethinking hierarchy will muddy the product.

The popup should become a **tab-groups command center**, not an AI panel with a Focus widget bolted on.

### Recommended popup hierarchy

At the top:

> **Current context: Work**
> `[Work] [Personal] [Reading] [Show all]`

Then below:

> **Organize tabs**
> AI grouping / regroup / apply

The switcher should be above AI grouping because switching context is the core, fast, repeated action. AI grouping is a setup/maintenance action.

Also: stop auto-running AI preview just because the popup opened. That behavior made sense when the popup’s whole purpose was AI grouping. It will feel hostile once the popup becomes a switcher. Opening the popup to switch contexts should not unexpectedly start “Organizing your tabs…”

### Recommendation

Make the popup title something like:

> **Tab Contexts**
> or
> **Focus Tab Groups**

Not:

> **AI Tab Groups**

AI grouping should be a secondary card or section.

---

## 5. Current “not connected to mac-command-centre” messaging must disappear from normal UX

For a shareable extension, this is fatal:

> ⚠ Not connected to mac-command-centre

A Windows/Linux user, or a Mac user without the author’s daemon, will interpret that as “this extension is broken.”

The absence of the helper should be normal, not an error.

### Recommendation

Move helper connection status out of the main popup and into:

* an **Integrations** section
* diagnostics
* an Apple Focus setup card

The main UI should say nothing about mac-command-centre unless the user opts into Apple Focus integration.

Bad:

> Not connected to mac-command-centre

Good:

> Apple Focus integration: Not set up
> Manual switching and schedules work without it.

---

## 6. The precedence model is too invisible

This proposal is risky:

> Explicit sources override the schedule; the schedule is a fallback baseline that reasserts when nothing explicit is active. Last-explicit-wins.

That is technically reasonable, but not user-comprehensible unless surfaced very clearly.

Users will ask:

* Why did my browser switch back?
* Did the schedule override me?
* Is Apple Focus controlling this?
* What does “nothing explicit is active” mean?
* If Raycast triggers Work for a Pomodoro, when does Work end?
* If I click Personal during a scheduled Work block, what happens at 9:01?

### Recommendation

Use a visible control model:

> **Active context:** Work
> **Controlled by:** Schedule
> `[Switch manually] [Resume automatic]`

Manual selection should become a clear **manual override**.

For v1, I would simplify further:

* Schedules fire at boundaries.
* Manual selections win until the next scheduled transition, or until the user clicks “Resume automatic.”
* External/Apple triggers are just triggers.
* The popup always shows the current source: Manual, Schedule, Apple Focus, External.

Avoid “fallback baseline” language. It is too abstract.

Also be careful with schedules that have `{days, start, end}`. The end time implies a switch-away behavior. To what?

You need to decide:

* End time switches to **Show all**
* End time switches to a configured default context
* End time does nothing
* End time resumes automatic schedule evaluation

That needs to be explicit in UI.

---

## 7. “Every tab-group title is a latent Focus” is useful, but it should not flood Options

This is a good idea for the popup:

> Existing tab groups are immediately switchable.

But I would not make every tab-group title a full context row in Options automatically. That turns transient browser state into configuration noise.

A tab group named `temporary hotel search` should not necessarily become a permanent “Focus.”

### Recommendation

Separate these concepts:

* **Saved contexts**: durable, editable, schedulable
* **Single-group quick switches**: transient actions based on current Firefox groups

In the popup, you can show:

> Saved contexts
> Work, Personal, Writing
>
> Current groups
> Docs, GitHub, Shopping

Each current group can have:

> Show only this
> Save as context

That gives zero-config utility without polluting the model.

---

## 8. Raycast should not be first-class in the main product

Given your own validated facts, Raycast cannot be read as a state source. It can only trigger something by running a script, and because the extension cannot listen locally, that script needs a helper.

That makes Raycast a power-user recipe, not a first-class integration.

If you market “Raycast Focus integration,” users will expect two-way sync with Raycast Focus sessions. You cannot provide that.

### Recommendation

Do not present this as:

> Raycast Focus integration

Present it as:

> External commands
> Trigger a browser context from Raycast, Stream Deck, shell scripts, or automation tools.

Then document Raycast as one example:

> Create a Raycast script command that runs `focusctl activate work`.

The UI should say:

> One-way trigger. This does not read Raycast Focus session state.

Raycast is useful, but niche. It belongs in docs or an advanced Integrations page, not the onboarding path.

---

# 2. User path critique

## Path A: brand-new macOS user with no daemon

### Current likely cliff

They install “Focus Tab Groups,” open the popup, and see AI grouping plus a warning about mac-command-centre. Options talk about raw Apple Focus identifiers. The product feels private, unfinished, or broken.

### Desired aha

They open the popup and see:

> Show only one tab group, or switch to a saved context.

If they already have tab groups, they can click one and immediately see the tab strip narrow. That is the aha.

If they do not have tab groups, the product must explain:

> This extension works with Firefox tab groups. Create some manually or use Organize tabs.

### Needed changes

* Remove daemon warning from normal popup.
* Remove Apple/raw-ID language from top-level Options.
* Make manual switching work without setup.
* Show Apple Focus as optional integration only.

---

## Path B: Windows/Linux user

### Current likely cliff

The word “Focus” plus macOS copy implies the extension is not for them. If they see mac-command-centre or Apple Focus IDs, they are gone.

### Desired aha

They should understand:

> This is a tab-group view switcher. It works on any OS.

Manual and schedule are the headline. Apple Focus is irrelevant.

### Needed changes

* Update manifest description.
* Update Options header.
* Avoid OS-specific copy in the core UI.
* Rename the core object away from “Focus mode.”
* Make schedules and manual switching feel native, not like fallbacks.

---

## Path C: the author / existing MCC user

### Current value

The author already has the power workflow: macOS Focus changes collapse/expand Firefox groups.

### Risk in the redesign

If you merge catalogs naïvely, the author may suddenly see duplicate Work/Sleep/DND rows: defaults, OS IDs, and group-derived items.

### Desired migration

On upgrade, existing Apple Focus mappings should become local contexts or bindings cleanly.

For example:

> Imported Apple Focus mappings
> Apple Focus “Work” now activates Context “Work.”

The author should see one `Work` context with an Apple Focus trigger attached.

### Needed changes

* Migration path from `focusMappings[appleFocusId]` to local context + Apple binding.
* Raw Apple IDs hidden by default but visible in trigger details.
* Existing MCC remains supported, but is no longer the mental model.

---

## Path D: Raycast user

### Likely motivation

They want a command palette action:

> Start Writing mode
> Start Work mode
> Show all groups

### Cliff

They may assume Raycast Focus session state can be synced. It cannot.

They may also not want to install a helper just to trigger a browser extension.

### Desired aha

Raycast users should see this as automation glue:

> I can make a Raycast script command activate a browser context.

### Needed changes

* Do not call it Raycast Focus sync.
* Do not make it a first-class onboarding card.
* Offer a helper/CLI only for users already motivated by automation.
* Present Raycast as one recipe under “External commands.”

---

# 3. Does the zero-config promise actually deliver?

Partially — but not through defaults.

The promise:

> Default Focuses + manual switcher works day one

Only delivers if the user has matching group names. Otherwise it is mostly decorative.

The stronger zero-config promise is:

> Your existing Firefox tab groups are instantly switchable.

That is real value.

## Minimum 5-minute retention experience

Within five minutes, a stranger needs to experience this loop:

1. Open popup.
2. See existing tab groups.
3. Click one.
4. Other groups collapse.
5. Click “Show all.”
6. Save a useful combination as a context.

That is the keeper moment.

Defaults can help later, but they are not the aha.

### Recommended first-run behavior

If tab groups exist:

> **Current groups**
> Show only: Work, Research, Shopping
> `[Show all groups]`

Also show:

> Save current visible groups as a context

If no tab groups exist:

> No Firefox tab groups yet.
> Create tab groups to use contexts, or use Organize tabs to group this window.

Then offer:

> Organize tabs

But do not pretend Work/Personal/Reading already do something.

---

# 4. Naming and mental model

I would stop calling the user-created object a “Focus.”

“Focus” is overloaded in at least four ways:

* macOS Focus
* Raycast Focus
* browser/page focus
* generic productivity focus

Also, “Focuses” is awkward as a plural.

## Recommended vocabulary

Use:

> **Context**

Examples:

* Active context
* Switch context
* Save as context
* Context schedule
* Context triggers
* Show all groups

Use:

> **Trigger**

Instead of “source.”

Examples:

* Manual trigger
* Schedule trigger
* Apple Focus trigger
* External command trigger

Use:

> **Apple Focus**

Only for the macOS integration.

Avoid saying:

* Focus mode
* Focus ID
* raw Apple Focus identifier
* mac-command-centre in normal UI
* Raycast Focus sync

## Product mental model

The cleanest explanation is:

> A context is a saved view of your Firefox tab groups. Switching context collapses groups that do not belong to it. Your tabs stay open.

That one sentence is much clearer than “Focus modes drive tab groups.”

## Possible UI copy

Manifest description:

> Save and switch Firefox tab-group contexts. Show only the groups you need, manually or on a schedule.

Popup header:

> Tab Contexts

Active state:

> Showing: Work
> Triggered by: Manual

Reset:

> Show all groups

Options section:

> Contexts
> Choose which tab groups are visible in each context.

Integrations section:

> Triggers
> Switch contexts automatically from schedules, Apple Focus, or external commands.

---

# 5. Helper/daemon adoption cliff

Realistically, most users will not install a helper.

A local broadcaster can be valuable, but only for a small group:

* macOS power users
* Raycast users
* Stream Deck users
* people comfortable with local automation
* the author

For everyone else, helper installation is friction and suspicion.

So OS-Focus-driven switching should not be the headline of the shareable product.

## Recommended positioning

Headline:

> Switch Firefox tab-group contexts manually or on a schedule.

Secondary:

> Optional integrations can trigger contexts from Apple Focus, Raycast, Stream Deck, or scripts.

Apple Focus card:

> Apple Focus
> Optional helper required
> Connect macOS Focus modes to browser contexts. Manual switching and schedules work without this.

External commands card:

> External commands
> Optional helper required
> Trigger contexts from Raycast, Stream Deck, shell scripts, or automation tools.

Diagnostics:

> Helper connection: Connected / Not installed / Reconnecting

But do not show “not connected” as an error in the main popup.

---

# 6. Raycast specifically

Raycast is worth documenting. It is not worth making a first-class product pillar.

The honest promise is:

> Raycast can trigger a browser context through a script command, if the helper is installed.

The dishonest-sounding promise would be:

> Raycast Focus integration

Avoid that.

## Recommended presentation

In an advanced “External commands” page:

> Use Raycast, Stream Deck, shell scripts, or other tools to activate a context.
>
> Requires the local helper.
>
> This is one-way: commands can activate a context, but the extension does not read Raycast Focus session state.

Then show recipes:

* Raycast script command: Activate Work
* Raycast script command: Show all groups
* Stream Deck button: Activate Recording
* CLI: Activate Reading

Raycast Focus sessions can be mentioned only as:

> You can start a Raycast Focus session and trigger a browser context from the same Raycast command, but Focus Tab Groups does not subscribe to Raycast Focus state.

That is clear and avoids overpromising.

---

# 7. Specific critique of your proposed sections

## A. Reframe

Directionally correct.

But I would change:

> A Focus = named context

To:

> A Context = named tab-group view

Make “Focus” the brand or optional integration vocabulary, not the object name.

Also, do not let the daemon catalog participate as a peer source of truth. It should provide trigger candidates and metadata only.

## B. How a Focus comes to exist

Good instinct, but needs adjustment.

### Bundled defaults

Use as templates, not active rows unless they match real groups or are explicitly created.

### Existing tab groups

Strong. This should be the main zero-config path.

But distinguish:

* “Show only this group” = quick action
* “Save as context” = durable object

### OS catalog

Do not let the OS catalog auto-create visible contexts forever. Treat it as:

> Apple Focus modes detected. Bind each to a context.

For first MCC migration, auto-import existing mappings to avoid breaking the author. For new OS catalog entries, ask whether to bind/create.

---

## C. Robust zero-config default

Yes to the popup switcher.

No to relying on defaults as the main value.

The robust zero-config version is:

> Existing groups are switchable immediately.

Also, “All/None” should become:

> Show all groups

“None” is ambiguous. None of what? No active context? Collapse all groups? Disable automation?

Use plain language.

---

## D. Sources

The table is technically sound, but the UI should not expose all sources equally.

Product hierarchy should be:

1. Manual switcher — core
2. Schedule — built-in automation
3. Apple Focus — optional helper integration
4. External commands — optional helper integration
5. Raycast — recipe under external commands

Do not make Raycast Focus a row in the main product model.

---

## E. Precedence / conflict resolution

This is underdesigned.

“Schedule as fallback baseline” is a power-user model. It will feel haunted unless the popup always shows who is in control.

Minimum UI requirement:

> Active context: Work
> Triggered by: Schedule
> Manual override active / Resume automatic

Also decide what happens when:

* schedule ends
* Apple Focus turns off
* helper disconnects
* external command activates a context during scheduled time
* user clicks Show all during scheduled time

Do not bury these semantics.

---

## F. Configuration UX

Rendering the merged Focus list in Options is the wrong shape.

Render saved contexts.

Each context row/card can contain:

* name/icon/color
* visible tab groups
* patterns/advanced matching
* schedule
* trigger bindings

Have a separate “Current tab groups not used anywhere” helper area if needed.

The current table/chip model can survive, but the copy must change from Apple/raw-ID language to context language.

---

# 8. Recommended minimal first release

The smallest release that proves the shareable thesis is not Raycast, not the helper, and probably not even full scheduling.

## Ship first

### 1. Local contexts

Create a canonical local context model.

Existing daemon/MCC mappings should migrate into contexts, but contexts should not depend on MCC.

### 2. Popup context switcher

Top of popup:

* active context indicator
* saved contexts
* current tab groups as quick switches
* Show all groups

This is the shareable core.

### 3. Context creation from real browser state

Include:

* Save this group as context
* Save current window’s groups as context
* Create empty context as secondary/advanced

Do not rely on a blank “New Focus” modal, but do not remove creation.

### 4. Existing tab groups as quick switches

Even without saved contexts, the popup should be useful if the user has Firefox tab groups.

### 5. Clean empty states

If no groups exist, say so plainly and point to group creation / Organize tabs.

### 6. Remove helper warnings from primary UI

No mac-command-centre warning in the popup for ordinary users.

### 7. Rename user-facing object

Use “Context” or “Tab Context.”

### 8. Update all public copy

Especially manifest description and Options header. The current copy still says the product is macOS Focus + mac-command-centre.

## Defer

### Defer schedule unless you can make control state obvious

Schedule is valuable, but it introduces precedence questions. It is the first thing I would add after the manual switcher works.

If you do include it in the first release, keep it simple:

* schedule activates context during interval
* outside intervals show all groups, or a clearly chosen default
* overlapping schedules are disallowed or visibly warned
* popup shows “Triggered by Schedule”

### Defer slim broadcaster

Do not make helper installation part of the first-run experience.

### Defer Raycast as UI

Ship docs/recipe later under External Commands.

### Defer source-precedence sophistication

Do not build a full multi-source priority system until users actually need it.

---

# 9. The blunt version

The right product is **not**:

> macOS Focus, but with fallback defaults and more sources.

The right product is:

> A Firefox tab-group context switcher that can optionally be automated.

That means your most important work is not adding sources. It is deleting the macOS-shaped assumptions from the primary UX.

The first release should make a Windows user with existing Firefox tab groups say:

> “Oh, I can click Work and the browser narrows to Work.”

If they instead see:

> “Not connected to mac-command-centre”

or:

> “Add Apple Focus ID”

or five default modes that do nothing, the shareable thesis fails.

My strongest recommendations:

1. **Rename the core object to Context.**
2. **Make local contexts canonical.**
3. **Do not render a merged catalog as peer rows.**
4. **Make the popup a context switcher first, AI organizer second.**
5. **Treat existing tab groups as quick switches, not automatic saved contexts.**
6. **Keep creation, but make it creation-from-existing-state.**
7. **Make Apple Focus and Raycast optional advanced triggers, not headline features.**
8. **Do not show helper absence as an error.**

That shape gives you a product strangers can understand without knowing anything about MCC, Apple internals, WebSockets, Raycast limitations, or raw Focus IDs.
