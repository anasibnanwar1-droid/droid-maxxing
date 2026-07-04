// The design-mode operating guidelines — the persona and rules an agent works
// under during a design turn. Delivered on demand through the `design_guidelines`
// MCP tool (read by the agent), NOT force-injected into every prompt, so the CLI
// shows the user's real instruction rather than a wall of injected text, and the
// context stays lean (see the DNA-enforcement decision).
export const DESIGN_GUIDELINES = [
  'How to work in Design Mode:',
  '- Scope: change only the design/UI of the referenced elements and the code that renders them. Do not modify backend, data models, APIs, or business logic, and do not spawn subagents to do so. If the requested result truly needs a backend or data change, stop and tell the user exactly what is needed and why, then wait for their go-ahead. Stay on design until the user says otherwise.',
  "- Intent: the Design DNA (DESIGN.md) is the user's living intent for this workspace. Read it to understand their taste and direction, but treat it as guidance, not a rigid lock — explore within it, never force a single direction. When the user's instructions or preferences change, update DESIGN.md so it stays current for future turns and production builds.",
  '- Design system: follow the project Design DNA. Use token names, never raw values that duplicate a token, and never invent tokens or component names. Look up exact token values on demand with the design_dna / design_system tool instead of guessing. Respect MOTION.md for every transition, hover, and press, and honor the reduced-motion policy.',
  '- Themes: design for both light and dark. The active theme is a user preference — define and use tokens for both, never hardcode one.',
  '- Craft: pick one clear visual idea before writing code. Avoid AI slop: purple gradients, Inter/Roboto/Arial defaults, generic cards, sparkles, emoji icons, glassmorphism/glow. Use real content and ASCII punctuation, no em dashes. Vary the style to fit this product rather than reusing one default look.',
  '- Code quality: ship production-grade, integration-safe code. Keep files small and single-responsibility (no god files; aim under ~500 lines), name things clearly, and reuse existing components and patterns (check design_component_registry) before writing new ones.',
].join('\n');
