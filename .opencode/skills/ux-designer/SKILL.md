---
name: ux-designer
description: UX researcher and designer — creates user flows, wireframes, interaction specs. Focuses on usability and flow before pixels. Use when: need user flows, wireframes, interaction design, accessibility review.
disable-model-invocation: true
---

# UX Design Workflow

**Leading word: Flow** — user journey before pixels. First map how the user moves through the system, then decide how it looks.

---

## Steps

### 1. Understand the user

Identify the actor, their goal, and the context of use before drawing anything.

- **Who**: user role, device, technical literacy, environment (e.g. "logged-in admin on desktop", "first-time visitor on mobile").
- **What goal**: single concrete outcome the user wants to achieve.
- **What context**: constraints (time, attention, interruptions), entry point, prior knowledge.

**Criteria**: a one-sentence user story is written and agreed before any flow or wireframe is started. Example: *"As a restaurant owner on mobile, I want to update my menu prices so customers see correct pricing."*

---

### 2. Map the flow

Trace the step-by-step journey from entry to completion. Cover happy path, edge cases, and errors.

- Sequence of screens/states the user passes through.
- Decision points (branches, conditionals, confirmations).
- Error states at each step (validation failures, network loss, empty states, permission denied).
- Exit points (success, cancellation, timeout).

**Criteria**: a linear or branching diagram is produced — either as a markdown list, Mermaid flowchart, or numbered steps. Every decision and error state is explicitly listed.

---

### 3. Wireframe the layout

Build low-fidelity layout for each unique screen in the flow. No colours, no real content — only structure and hierarchy.

Use one of these formats:
- **ASCII art** for quick layouts within code comments or specs.
- **Markdown tables** to describe component placement and proportions.
- **HTML with minimal CSS** if a browser-ready prototype is needed.

Include:
- Content zones (header, body, sidebar, footer).
- Hierarchical grouping (cards, sections, lists).
- Primary action placement (CTA, submit, confirm).
- Empty states and error message placement.

**Criteria**: every screen in the flow has a corresponding wireframe. Wireframes are readable without explanation — labels or annotations clarify ambiguous zones.

---

### 4. Specify interactions

Define component behaviour across all relevant states. Use a table or bullet list per interactive element.

| State | Behaviour |
|-------|-----------|
| Default | Appearance and behaviour at rest |
| Hover | Visual feedback on mouse-over |
| Focus | Keyboard focus ring or highlight |
| Active / Pressed | Momentary feedback on click/tap |
| Disabled | Greyed out, not interactive, with tooltip why |
| Loading | Spinner, skeleton, or progress indicator |
| Error | Inline validation message, field highlight |
| Success | Confirmation toast, checkmark, next-state transition |

Specify:
- Transition duration and easing for animations.
- Touch target size (min 44×44 px for mobile).
- Timeouts for auto-dismissing notifications.

**Criteria**: every interactive component has at least Default, Disabled, Loading, and Error states defined. Hover and Focus are defined for all clickable elements.

---

### 5. Accessibility check

Verify the design against baseline accessibility requirements.

- **Colour contrast**: minimum 4.5:1 for normal text, 3:1 for large text (18px+ bold or 24px+ regular).
- **Keyboard navigation**: all actions reachable via Tab / Shift+Tab, visible focus indicator, no keyboard traps.
- **Labels**: every form field has an associated `<label>` or `aria-label`. Icon-only buttons have accessible names.
- **Focus order**: follows visual reading order (top→bottom, left→right). No unexpected jumps.
- **Screen reader**: semantic heading hierarchy (h1→h2→h3), landmarks, alt text on meaningful images.
- **Motion**: reduce-motion query respected for animations. No auto-playing content.
- **Touch**: minimum 44×44 px tap targets. Adequate spacing between interactive elements.

**Criteria**: a checklist is completed per screen. Any accessibility violation is either fixed or documented as a known issue with a tracking reference.

---

## Reference: Design principles

Apply these principles to every design decision:

| Principle | Application |
|-----------|-------------|
| **Clarity** | Each screen has one primary purpose. Remove distracting elements. Use plain labels, not marketing copy, for actions. |
| **Progressive disclosure** | Show only what the user needs at each step. Advanced options are hidden behind "More" or "Advanced" toggles. |
| **Error prevention** | Where possible, constrain inputs (dropdowns, sliders, formatted fields) rather than showing errors after submit. Confirmation dialogs for destructive actions. |
| **Consistency** | Same pattern for same meaning across the whole product: same button placement, same icon for same action, same terminology. Follow platform conventions (OS-native components, gestures, patterns). |

## Reference: Responsive behaviour

Design for three breakpoints at minimum:

| Breakpoint | Layout behaviour |
|------------|-----------------|
| **Mobile** (< 640 px) | Single-column stack. Bottom navigation or single top bar. Full-width inputs and buttons. Bottom-sheet for overlays instead of modals. |
| **Tablet** (640–1024 px) | Two-column grid where appropriate. Sidebar collapsible. Same touch targets as mobile. |
| **Desktop** (> 1024 px) | Multi-column layout. Persistent sidebar navigation. Hover-based tooltips and dropdowns. Keyboard shortcuts exposed. |

Guidelines:
- Content should reflow, not hide. Avoid "mobile = less content" without evidence.
- Test all flows at every breakpoint before calling a design complete.
- Use relative units (rem, %, vw/vh) for layout; use px only for borders and shadows.
