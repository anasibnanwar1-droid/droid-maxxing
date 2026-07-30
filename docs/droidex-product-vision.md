# DROIDEX product vision: a design practice, not a design generator

Status: product direction document, July 2026. This sits above `design-roadmap.md`: the roadmap sequences the build; this document defines what the product is, who it is for, and why every piece exists. Where the two disagree, this document wins.

## The thesis

**DROIDEX is a design practice, not a design generator.** The generator is a commodity: every provider can turn a prompt into a screen. The practice is what design agencies charge $50k for and what no AI tool does: discovery, understanding the client, taste, iteration on the real product, and motion as a first-class material.

Everything in this document hangs off one principle:

> **The understanding is the asset. The model is interchangeable labor.**

A serious founder or team comes to DROIDEX because the tool knows their product the way an agency that has worked with them for a year does. That knowledge lives in their repo, belongs to them, and travels with them across models. When they swap models mid-project, the new model reads the same understanding and picks up like a senior designer joining an ongoing engagement, not a stranger asking "what's your favorite color?"

## Why DROIDEX over the direct providers

Claude Design, Figma Make, MagicPath, and Cursor Design Mode all answer the same question: "design me something new." Greenfield generation is a race DROIDEX does not need to run. DROIDEX answers the question nobody serves: **govern and evolve the design of the product you already have, and understand the client before designing anything new.**

What the providers structurally cannot copy fast:

1. **Local execution on the real codebase and real dev server.** No cloud sandbox, no credit meter, no export step that loses the mapping back to source.
2. **Design decisions as repo artifacts.** `UNDERSTANDING.md`, `DESIGN.md`, `MOTION.md`, and the component registry live in git, versioned, portable, owned by the user.
3. **Measurement of rendered output.** Deterministic pixel-to-`file:line` anchors and a validator that checks what actually rendered, quietly, inside the loop.
4. **A discovery practice.** Providers ask about colors. DROIDEX runs the engagement a real design team runs.

DROIDEX is free. The pitch is not "cheaper generation"; it is "the parts of design that big companies take years to ship internally: design QA tooling, brand governance, discovery practice, rebrand infrastructure, delivered as a local app that works on your actual product."

---

## Pillar 1: The Discovery Engine (the front door)

Replace the intake form with an adaptive discovery engagement, modeled on how real design teams work with clients.

### A real question bank, not "pick a vibe"

AI tools ask about colors and moods. Real designers fill a discovery document that covers:

- **Brand strategy.** What should someone feel in the first five seconds? Who are you deliberately NOT for? What would make you embarrassed if your product looked like it?
- **Audience reality.** Context of use: device, urgency, expertise level, time of day, emotional state when they arrive.
- **Business goals.** What single action pays your bills? What does success look like in 90 days?
- **Competitive positioning.** Who do users compare you to? Where do you refuse to look like them, and where is looking similar actually correct?
- **Content truth.** What copy, data, imagery, and real content actually exist today? Design against real content, not lorem ipsum.
- **Constraints.** Accessibility requirements, platforms, legacy systems, brand rules that cannot move.
- **Emotional targets.** The three words the product should evoke, and the three it must never evoke.

The question flow is adaptive, not a fixed form. Answers open branches the way a designer follows a thread: "you said users arrive stressed; walk me through the worst moment in their day where they open your app."

### Show, don't interrogate

Half of real discovery is reactive: designers show things and read the client. So many "questions" are rendered probes on the canvas: two live directions side by side, "which feels more like you, and why?" The *why* is the gold. The canvas makes discovery visual and fun instead of a form to fill out.

This uses machinery that already exists: the intake flow that explores N rendered directions before committing DNA becomes a discovery instrument, not just a style picker. Every probe reaction is recorded with the reason attached.

### Progressive, never done

Discovery is not a one-time questionnaire. It deepens across sessions, continuously, the way a good lead designer keeps learning the client:

- The system notices gaps and raises them at natural moments: "we've never talked about empty states or error tone."
- New work triggers new questions: the first time the user asks for a pricing page, discovery asks about pricing psychology and competitor pricing pages before generating.
- Contradictions get surfaced, not silently overwritten: "in March you said playful; this request reads formal. Has the direction shifted, or is this page an exception?"

Discovery is a background posture of the whole product, not a wizard screen.

### How the agent asks (question craft)

The quality of the practice lives in how questions are asked, so question craft is a specified behavior, not a model vibe:

- **One question at a time, and every question is earned.** The agent asks only what the understanding's open gaps justify, at the moment the gap blocks real work. Never a battery of questions, never re-asking what the file already answers.
- **Show, then say.** Whenever a question can be asked visually, it is: render the two interpretations and ask which one, instead of asking the user to imagine. Words are the fallback channel, not the default.
- **Typed taste is first-class.** Every visual probe has a typed-answer equivalent. A user who would rather write "restrained, editorial, never glossy, never startup-purple" than tap frames gives richer signal, and the agent's reply to typed taste is a rendered interpretation ("this is what I heard"), offered as optional confirmation, never a forced pick.
- **Always capture the why.** A pick without a reason is half a signal. The follow-up is one short "what made this one right?", and the answer is quoted into the record.

---

## Pillar 2: The Understanding File (the saved asset)

Everything discovery learns compiles into a structured, versioned, repo-resident **`UNDERSTANDING.md`**, sitting above `DESIGN.md` and `MOTION.md` in the DNA hierarchy:

- Audience, goals, and emotional targets, with the user's own words quoted.
- Taste signals with evidence: "rejected direction B on 2026-07-12 for feeling corporate; picked the version with looser spacing."
- The never-do list.
- Decisions with reasons, so future turns (and future models) know not just *what* was chosen but *why*.

### The context-aware workspace (model choice belongs to the user)

DROIDEX never pushes a model on the user and never frames one model as "the tasteful one." Model choice is entirely the user's: they pick whatever model they want to work with, and they change it whenever they want, typically when starting a new session. The product's job is different: **make the workspace context-aware so that any model, the moment it enters, works better than it would anywhere else.**

- Every session, regardless of model, starts by reading `UNDERSTANDING.md` plus the DNA files. A model joining the project mid-engagement sees the client's answers, the taste history, the rejected directions and why, like a designer who has been on the account, not a stranger re-onboarding.
- This is more than normal context passing. The workspace *accumulates* understanding over time: every discovery answer, every probe reaction, every pick and rejection deepens the files. A session in month three starts smarter than a session in week one, on any model.
- The understanding is written *for models as much as for humans*: structured sections, explicit decisions, quoted client language, current open questions. That is what makes it portable, not any switching mechanism.
- Visuals are part of how the workspace works with the user, exactly like a $50k agency: it shows rendered directions, reads the reactions, and remembers them. Over time the visual history (kept directions, rejected fans, annotated references) is as much a part of the understanding as the text.

The understanding also compounds the Taste Engine: every variant-fan pick, every rejection reason, every probe reaction feeds back into it. The file is the memory that makes the loop get smarter.

### Taste is recorded as observations, never as facts

Clients change their minds: "I hate orange" in July week three, "I want orange" in week four. A good designer never records taste as a fact; they record timestamped, scoped observations, and so does the understanding:

- **The signal log is append-only.** Nothing is overwritten. The file never says "client hates orange"; it says "rejected orange on the hero on 07-21, felt like a sale banner" and later "wants orange as an accent on 07-28, saw it on a poster, feels alive."
- **Three tiers of stability.** *Principles* (the never-do list, promoted only explicitly; contradicting one triggers a question, never a silent change). *Decisions with reasons* (most contradictions dissolve here, because taste is almost always scoped: it was not orange, it was orange at that size in that place; the agent's job is to find the scope that makes both statements true). *Current leanings* (recency-weighted; last month's mood loses to this week's, but the history stays).
- **Unscopable contradictions become the one designer question:** "has the direction shifted, or is this an exception?" The answer is the recorded reason. Contradictions are data, not errors.

### The understanding is visual too

The markdown files are the database; the canvas is the interface. Nobody should need to read `UNDERSTANDING.md` to know what the product feels like, the same way a client never reads the agency's internal notes; they see the wall:

- **The Understanding Wall.** A permanent canvas board, like the wall in a studio: emotional targets rendered as small specimens (not the word "restrained"; a restrained card next to a loud one, yours highlighted), kept directions as thumbnails, the never-do list as crossed-out visual examples.
- **The taste timeline.** The signal log rendered as a scrubable visual strip: every pick, rejection, and flip with a thumbnail. The orange story reads as a visible narrative of the direction evolving, exactly like an agency's "how we got here" deck.
- **Drop-anything mood capture.** Drag an image, screenshot, or URL onto the canvas and it becomes an annotated reference instantly; the agent extracts what is extractable and asks one question about *why* it was dropped.

### The understanding outgrows design

`UNDERSTANDING.md` is product understanding, not visual preference. A backend agent benefits from it just as much: error-message tone, what to optimize when the audience arrives stressed and on mobile, which endpoint matters because it is the action that pays the bills. The understanding pointer therefore goes to *every* session in the workspace, not only design ones. The enforcement and canvas layers stay design-specific by nature; the understanding layer is workspace-wide.

---

## Pillar 3: References as hypotheses, not templates

References are good for starting, never authoritative.

- References enter the library **dated and tagged with what resonated**: "this landed with the client in March, for its type rhythm, not its color."
- References **decay**. A six-month-old reference is a historical signal, not a current instruction. Trends move; the client's taste moves.
- References can be **contradicted** by newer taste signals, and the contradiction is recorded rather than hidden.
- `UNDERSTANDING.md` always outranks the reference library. When a reference and the understanding disagree, the understanding wins and the reference gets annotated.

The existing reference capture (`referenceLibrary.ts`, `referenceExtract.ts`) stays; what changes is its epistemic status: probes and evidence, not templates to imitate.

---

## Pillar 4: The living product (real app, real motion, in the canvas)

The canvas should host reality, not specimens. "Real feel" means the user sees their actual product, their actual components, and their actual motion, live and interactive.

### The universal canvas: web → Electron → iOS

- **Web now.** The isolated-worktree dev server renders the real app in canvas frames with pixel-to-`file:line` anchors. Multi-viewport frames (desktop/tablet/mobile) of the same live page.
- **Electron next.** Droid Control already drives Electron apps; the canvas embeds the real running desktop app so design work happens against production surfaces, not mockups.
- **iOS later.** The iOS Simulator streamed into a canvas frame (`simctl` for frames and touch injection), the agent editing SwiftUI with hot reload. Designing a real iOS app on an infinite canvas with an agent is a category-defining capability; even a rough v1 changes what the product is.

### Design DNA visualized, not just stored

DNA is a living object on the canvas, not a markdown tab:

- The brand book renders as a live frame: palette, type scale, spacing rhythm, radii, all interactive and both themes.
- **Guidelines demonstrate, never just describe.** Hover a motion rule and it plays at the real duration and easing; the spacing rhythm is an interactive ruler you can toggle over any frame; color pairs are shown inside real registry components, never as naked swatches. Every rule is a playable specimen.
- Token changes ripple visibly: edit a token and watch the open frames (real app pages, components, brand book) update in place.
- Saved directions render as a gallery the user can walk through, compare, and re-apply. A shipped direction gallery (a dozen-plus bundled specimens) means even an empty repo sees a rich starting fan in under a second, before any model is invoked.

### Component visualization: the self-writing workbench

The component library becomes a workbench where every component is rendered, interactive, and grounded in real usage:

- **Agent-synthesized stage harnesses.** When a component cannot render bare (needs props, providers, data), the agent reads its actual call sites from the registry and writes a cached stage harness in `.droidex/stages/`: realistic props sampled from real usage, the providers it needs, mock handlers. Built once, kept in the repo, improves over time.
- **Usage presets.** Each distinct call site becomes a named preset: "as used in Sidebar," "as used in Checkout." No design tool can do this because it requires the code.
- **State matrix.** Default / hover / focus / disabled / loading rendered simultaneously as a grid, because a lone centered instance is not a simulation.
- **Props knobs** auto-generated from registry prop types: variant dropdowns, boolean toggles, string inputs.
- **Tailwind and the real pipeline.** Previews run the project's actual CSS pipeline so components render as they ship, styled, not naked.

Pitch: a Storybook that writes itself from how your app actually uses each component.

### Motion grounded in real usage

`MOTION.md` stops being aspirational prose and becomes reconciled against observed behavior, across everything the codebase has:

- **Motion inventory.** The workbench drives real components and real app pages: programmatic hover / press / focus / mount across the whole registry, then `document.getAnimations()` captures every animation's exact duration, easing, and keyframes. The result is an inventory of what the product's motion *actually is today*, component by component, page by page.
- **Written from reality, then enforced against it.** `MOTION.md` is authored from and reconciled with the inventory. Divergence is visible: "your DNA says micro interactions are 120-160ms; 14 components run at 300ms; 9 interactive components have no motion at all (dead interactions)."
- **The motion pass.** One sweep that retrofits the existing codebase to the motion DNA: fixes off-token timings, adds motion to dead interactions, respects `prefers-reduced-motion`, each change previewed as before/after in the workbench so approval is visual, not a diff.
- **Motion visualization in the canvas.** Select any element and get a **motion scrubber**: scrub the animation timeline, bend the easing curve with a handle, adjust duration on a dial; the agent writes the change back as token-correct code. Motion becomes something you feel and tweak, not describe in text.
- **Parseable motion tokens.** A fenced `motion-tokens` block in `MOTION.md` (durations, easings, press scale, reduced-motion policy), parsed alongside design tokens, so the inventory, the scrubber, and the quiet validator all speak the same language.

### The design-readiness pass (the onboarding funnel)

Most production repos are not designable: inline styles, hex soup, duplicated UI, no theme seam. One honest feature fixes that: the agent audits the repo and produces a **design-readiness report and refactor plan**: extract values into tokens, componentize duplicates, install the theme seam, all in the isolated worktree, each step previewed. Every real app that goes through the pass becomes a repo where every other pillar works 10x better. This is how Electron apps and production apps of any age become first-class citizens.

**New workspaces are the clean case, not the awkward one.** Greenfield projects enter through discovery first (a pure agency kickoff, where rendered probes matter most because there is no product to react to), then direction fans, then a scaffold that is *born design-ready*: tokens, theme seam, and registry conventions from the first commit, with the enforcement loop guarding the codebase from line one so drift never accumulates. Existing apps enter through the readiness pass; new apps enter through discovery-first scaffolding; both converge on the same loop.

### Quiet measurement

Validators are backstage crew, never the show. They exist to serve taste:

- **Post-turn self-repair.** After any turn that touches UI files, the sidecar re-renders affected surfaces, audits them against the DNA (colors, type, spacing, radii, motion), and feeds violations back to the agent as automatic repair turns (capped) before the user sees the result. The user sees a badge: "DNA: 4 violations auto-fixed, 0 remaining." The agent cannot hand over off-DNA output.
- **Write-time layer.** On file save in the worktree, a cheap static check maps raw hex/px/duration values in changed files to the nearest token.
- **DNA scores and pins.** Findings render as overlay pins on canvas frames (audit elements carry box coordinates) with per-pin fix; each component in the workbench carries a DNA score. Enforcement becomes a visible metric, not a tab the user must operate.

---

## Pillar 5: The Taste Engine (the research bet)

Frontier models have taste; cheap models have competence. The harness closes the gap the same way Factory closes capability gaps: not by prompting harder, but by **shrinking the decision space until taste is the default** and by making selection do the work generation cannot.

- **Taste corpus, not prompt-stuffing.** Reference extraction distills captured sites into structured "moves": type pairings, spacing rhythms, hero compositions, nav patterns, each a small recipe with actual values. A cheap model choosing between twelve proven moves beats a cheap model inventing from scratch. This is how design systems make junior designers ship senior work.
- **Best-of-N with visual self-critique.** Cheap models are weak generators but decent critics. Render 3-4 variants (cheap means the samples are affordable), screenshot each, run one vision-critique pass against a short rubric (hierarchy, rhythm, contrast, restraint), then auto-pick or fan the survivors out to the user.
- **Personal taste profile.** Every variant-fan pick is logged against extracted features. Over weeks the harness learns *this user's* taste and biases the moves it deals. No provider has this because they do not own the local loop.
- **Understanding-conditioned generation.** The taste corpus and profile always generate *through* `UNDERSTANDING.md`. Taste without client understanding is just fashion; the combination is what an agency sells.

## Pillar 6: Design by picking, not prompting (the fun)

Chat is the wrong primary input for design. The canvas is the instrument:

- **Variant fans as the default turn output.** Every design request yields a spread of live frames; the user taps one, then taps again on the next refinement fan. It feels like play, and every tap feeds the taste profile and the understanding.
- **Direct manipulation that compiles to agent edits.** Drag a margin on the canvas; the agent writes the token-correct change. Select an element; get the motion scrubber. The gap between "I feel it should be tighter" and the code changing approaches zero.
- **Discovery probes on the canvas.** Pillar 1's show-don't-interrogate questions render here, so the same gesture (tap the one that feels right, say why) powers both discovery and iteration.

### One selection language everywhere

The design-mode DOM selection tool and the canvas selection/annotation tool merge into a single mechanism: the same element picker, the same annotation gesture, whether the surface is a canvas frame, the workbench, the brand book, or the native browser pane. Select anything, anywhere, and the selection resolves to the same shape (element, computed styles, `file:line` anchor, frame context) that both the user's annotations and the agent's tools speak. Annotate an element with "tighter" and that annotation *is* the prompt, carrying its full context.

### The agent inhabits the canvas

Agents everywhere build UIs they never use. DROIDEX closes that loop: the agent is a *presence* on the canvas, not a process behind it:

- **The agent understands and controls the canvas.** Compact tools give it the canvas state (what frames exist, what they show, where they are) and control over it: open, close, arrange, resize, and focus frames and panes. The agent composes its own workspace: a before/after pair for a review, a fan for a probe, a motion strip for a sweep.
- **The agent has its own cursor.** A visibly distinct second cursor on the canvas, driven by the agent, like computer use but inside the design surface. The agent navigates what it built: moves to the button, hovers it, presses it, tabs through the form, opens the menu. The user *watches the agent use the product*, which is both the most honest demo possible and the most fun the category has to offer.
- **The agent watches its own work.** After building, the agent walks its work with the cursor while the session records; then it reviews the recording (video frames plus the motion inventory from `document.getAnimations()`) as a self-critique pass. It does not just diff its code; it *sees and feels* what it made: the hover that never fired, the transition that stutters, the layout that jumps. Nobody in the agentic world has closed this loop; DROIDEX has the recording machinery, the driven interactions, and the canvas to do it.
- **Errors reach the agent as context, not as user complaints.** Console errors, failed requests, and render crashes in any frame are captured, source-mapped to `file:line`, and attached to the frame's context automatically, so the agent debugging its own design work sees what broke and where without the user copy-pasting a stack trace.
- **The walkthrough deliverable.** The cloud-agent workflow, but local: assign design work, go do something else, and the agent builds in the worktree, then walks the result with its cursor while recording. The turn's deliverable is a short walkthrough video plus the diff: "here is what I built, watch me use it." No cloud sandbox, no upload; the video is rendered from your own running app on your own machine.
- **Video is an input, not just an output.** Users send video references the way they send image references: a screen recording of an app whose motion they love, a clip of their own product misbehaving, a competitor flow. The agent samples frames, reads the motion (timing, easing character, choreography), and files what resonated into the understanding and the reference library, dated and tagged like any other hypothesis.

All of this rides one engineering rule: **agent tools must be contextual and lean.** Every canvas tool returns a compact digest by default, detail only on demand, so inhabiting the canvas never bloats the context window.

---

## The loop that ties it all

```
Discover → understand → deal tasteful directions
   ↑           (taste corpus + best-of-N + personal profile,
   |            conditioned on UNDERSTANDING.md)
   |                        ↓
every pick and        pick visually on the canvas
rejection deepens            ↓
the understanding     build on the real app in the worktree
   ↑                        ↓
   └──── measure quietly (post-turn self-repair, DNA scores,
          motion inventory) ← next turn starts smarter
```

Serious people come here because the tool knows their product the way an agency that has worked with them for a year does. That knowledge is theirs, in their repo, portable across models: any model they choose to work with reads the same understanding and works better because of it.

## What this changes about the current build

Priorities implied by this document, in order:

1. **`UNDERSTANDING.md` + the Discovery Engine.** Evolve the intake interview into the adaptive, ongoing discovery practice; make the understanding file the first artifact every session reads and the last thing every session updates.
2. **Workbench usefulness.** Stage harness synthesis from call sites, usage presets, state matrix, real CSS pipeline. The component library must be genuinely useful before anything is layered on it.
3. **Motion reality.** `motion-tokens` fence, motion inventory via driven interactions, the motion pass, the scrubber.
4. **Quiet enforcement.** Post-turn self-repair loop and DNA scores; retire the validator as a user-operated tab.
5. **Taste Engine.** Moves corpus from reference extraction, best-of-N critique, taste profile.
6. **Universal canvas.** Real app frames with anchors (web), Electron embed, then the iOS Simulator stream.
7. **Design-readiness pass** as the production-repo onboarding funnel.
8. **The inhabited canvas.** Unified selection and annotation across DOM and canvas, lean canvas-control tools, the agent cursor, self-review by recording, and the error-context loop.
