# ARCHITECTURE.md: AI Agent Global Map & Context Guide

**TARGET AUDIENCE:** AI Coding Agents (Cursor, Copilot, Gemini, etc.). 
**PURPOSE:** Prevent architectural side-effects, context blindness, and performance degradation during "Search and Edit" workflows. Read this document BEFORE proposing architectural changes, adding new features, or modifying core UI/data flows.

---

## 1. Project Overview & Core Stack
**App:** Advanced AI Chat Interface powered by the Google Gemini API (`@google/genai`). Features include multi-persona character mode, Agentic RAG (Long-Term Memory), Python execution (Pyodide), Text-to-Speech (Tone.js), and Novel Archiving.
**Core Stack:**
- **Frontend:** React (TypeScript), Tailwind CSS.
- **UI Paradigm:** Zinc & Emerald Soft UI (Vercel/Linear aesthetic). Atomic Component Library.
- **State Management:** Zustand (Heavily modularized).
- **Persistence:** IndexedDB (Custom wrapper in `services/db/core.ts`).
- **Audio:** Tone.js (Web Audio API) for granular TTS playback.
- **Heavy Compute:** Web Workers (Python execution, MP3 encoding, ZIP Export/Import).

---

## 2. State Management & Data Flow
The app uses a highly modularized Zustand architecture. **NEVER** combine these stores or bloat them. 

### Core Data Stores (Persisted to IndexedDB)
- `useActiveChatStore`: Holds the *full* `currentChatSession` object (including all messages). This is the source of truth for the active UI.
- `useChatListStore`: Holds *summaries* (messages array stripped) of all chats for the sidebar.
- `useDataStore`: Handles direct IndexedDB syncs (e.g., `updateMessages`, `updateSettings`).

### Volatile / UI Stores (Not Persisted)
- `useStreamingStore`: **CRITICAL.** Holds the currently streaming text. Do NOT put streaming text into `useActiveChatStore` as it will cause the entire app to re-render on every token.
- `useGlobalUiStore`: Theme (light, dark, studio), language (RTL/LTR), font sizes.
- `useSettingsUI` / `useEditorUI` / `useConfirmationUI`: Manages modal visibility. **Rule:** Keep local UI toggles inside components via `useState`. Only use these stores for global overlays.

---

## 3. UI Architecture & Semantic Theming (STRICT RULES)
We have completely migrated to a **Semantic Theming System (Design Tokens)** and an Atomic Component Library. 
**CRITICAL RULE:** You are STRICTLY FORBIDDEN from using hardcoded color palettes (e.g., `zinc-900`, `gray-500`, `emerald-500`) or the `dark:` prefix for colors in any React component. 

The application is "Theme-Agnostic". Themes (`light`, `dark`, `studio`) are handled automatically via raw RGB CSS variables in `index.css` mapped through `tailwind.config.js`.

### A. The Atomic Library (`components/ui/`)
You MUST use the established UI primitives for all new features. NEVER use raw `<button>`, `<input>`, or `<select>` tags for standard UI elements.
- **`<Button>`**: Use variants (`primary`, `secondary`, `danger`, `ghost`, `outline`) and sizes (`sm`, `md`, `lg`, `icon`).
- **`<Input>` / `<Textarea>` / `<Select>` / `<Switch>`**: Use these for all forms.
- **`<Badge>`**: For status indicators (e.g., Active, Error).
- **`<Dropdown>`**: For all popup menus. It handles click-outside logic automatically. Do NOT write custom `useEffect` click-outside hooks.
- **`<Accordion>`**: For collapsible content. It uses native HTML `<details>` for zero React-state overhead.

### B. The Semantic Dictionary (Use These Classes ONLY)
Whenever you build or modify a component, you MUST use these semantic classes. They support Tailwind's opacity modifiers (e.g., `bg-bg-panel/50`).

**1. Surfaces & Backgrounds:**
- `bg-bg-app`: The deepest background of the application.
- `bg-bg-panel`: Modals, Sidebar, Header, and solid cards.
- `bg-bg-element`: Inputs, dropdowns, action chips, and neutral active states.
- `bg-bg-hover`: Standard hover state for elements.
- `bg-bg-overlay`: The backdrop behind modals (use with `/80`).
- `bg-bubble-user` / `bg-bubble-ai`: Strictly for chat message bubbles.

**2. Typography:**
- `text-text-primary`: Main body text and headings.
- `text-text-secondary`: Descriptions, subtitles, and secondary info.
- `text-text-muted`: Placeholders, timestamps, and inactive icons.
- `text-text-on-brand`: Text placed on top of solid brand-colored buttons (always white/light).

**3. Borders & Shadows:**
- `border-border-base`: Standard dividers and borders.
- `border-border-light`: Faint dividers.
- `focus:ring-ring-focus`: Focus rings for inputs.
- `shadow-panel`: Standard shadow for modals and dropdowns.

**4. Brand Colors:**
- `bg-brand-primary` / `text-brand-primary` / `border-brand-primary`: The main brand accent (Teal/Emerald).
- `hover:bg-brand-hover`: Hover state for primary brand elements.

### C. The Tint System (For Colored Cards & Badges)
If you need to create a colored feature card, alert, or badge, you MUST use the Tint System. 
Available colors: `teal, emerald, fuchsia, indigo, rose, sky, amber, orange, red, cyan, purple, slate`.

**Tint Rules:**
- **Backgrounds:** `bg-tint-[color]-bg` (MUST use an opacity modifier like `/10` or `/15` to create a soft glass effect. NEVER use solid).
- **Borders:** `border-tint-[color]-border` (Use with `/20` or `/30` opacity).
- **Text/Icons:** `text-tint-[color]-text` (NEVER use opacity on text to maintain readability).
*Example:* `className="bg-tint-indigo-bg/10 border border-tint-indigo-border/20 text-tint-indigo-text"`

### D. Markdown Typography (Standardized Semantic Baselines)
Markdown elements follow a standardized color semantic across all themes, with contrast ratios tailored to each background:
- **Bold:** Blue (Deep Blue in Light, Bright Blue in Studio/Dark).
- **Italic:** Green (Deep Green in Light, Bright Green in Studio/Dark).
- **H3 Headings:** Red (Strong Red in Light, Bright Coral in Studio/Dark).
- **Blockquotes:** Amber (Dark Amber in Light, Bright Amber in Studio/Dark).
- **Links:** Standard readable blues (Blue 600 in Light, Soft Blue in Studio/Dark).

---

## 4. Performance Critical Paths (DO NOT BREAK)

### A. `ChatMessageList.tsx` & `@tanstack/react-virtual`
- **Rule:** The message list is virtualized. Elements are absolutely positioned.
- **Gotcha:** Do NOT introduce CSS that breaks height calculations (e.g., unconstrained absolute children).
- **Gotcha:** Do NOT force scroll-to-bottom on every render. Use the smart stickiness logic already implemented.

### B. `MessageItem.tsx` (Streaming Performance)
- **Rule:** This component re-renders hundreds of times per second during AI streaming.
- **Gotcha:** NEVER use `motion/react` inside `MessageItem.tsx`.
- **Gotcha:** NEVER use `useState` for toggling UI elements (like Thoughts or Python code) inside a message. You MUST use the `components/ui/Accordion.tsx` (which relies on native HTML `<details>`) to prevent React state updates from lagging the stream.

### C. Anti-FOUC (Flash of Unstyled Content)
- **Rule:** Theme initialization happens via an inline script in `index.html` reading from `localStorage('global-ui-storage')`. Do not attempt to manage the initial theme class injection via React `useEffect`, as it will cause a white flash on load.

---

## 5. Highly Fragile Subsystems (HANDLE WITH EXTREME CARE)

### A. The Streaming Regex Trap (`useMessageSender.ts`)
- **Danger:** The app supports hiding "Thoughts" (e.g., `<thought>...</thought>`) from the UI *during* the live stream.
- **Rule:** If you modify the streaming logic, you MUST preserve the regex logic. Failing to do so will leak raw XML tags into the user's chat UI.

### B. Audio Chunking & Deletion (`useAudioStore.ts` & `audioDb.ts`)
- **Danger:** Long TTS audio is split into chunks to bypass API limits. They are stored in IndexedDB as `${messageId}_part_${i}`.
- **Rule:** If you write logic to delete a message, you CANNOT just delete `messageId`. You MUST loop through `message.cachedAudioSegmentCount` and delete every `_part_${i}`. Otherwise, you will cause massive IndexedDB memory leaks.

### C. IndexedDB Migrations (`services/db/core.ts`)
- **Dependency:** If you add a new Object Store or change a `keyPath`, you MUST increment `DB_VERSION` and add a new `if (oldVersion < X)` block inside the `onupgradeneeded` function. Failing to do this will corrupt the app for existing users.

---

## 7. RECENT REFACTORING & CLEANUP (MARCH 2026)

### A. Dead Code Eradication
- **Manual Save Button:** Removed `ManualSaveButton.tsx` and all related logic (`handleManualSave`) from `useDataStore.ts` and `ChatHeader.tsx`. The application now relies exclusively on robust auto-save.
- **Cache Management:** Removed `clearChatCache` from `useInteractionStore.ts`. Refactored `ChatHeader.tsx` to use a native `<button>` for cache status display with dynamic i18n titles (`cacheActive`, `cacheExpired`, `cacheInvalid`).
- **Hard Reload:** Introduced a dedicated "Hard Reload App" button in `SettingsAdvanced.tsx` (wired via `SettingsPanel.tsx`) that uses `clearCacheAndReload` from `pwaService.ts`.

### B. UI Efficiency
- **Chat Header:** Simplified the header by removing redundant dividers and obsolete buttons. The cache management button now uses a clean, native approach without the overhead of the `<Badge>` component.
- **Settings UI:** Renamed `onClearCache` to `onHardReload` in `SettingsAdvanced.tsx` to better reflect its actual behavior (PWA cache clearing + page reload).

### C. Iterative Auto-Refine & Tool Loop Stability (LATE MARCH 2026)
- **Auto-Refine Service:** Introduced `services/llm/autoRefineService.ts` to handle multi-step draft/critique/refine loops. This logic is decoupled from the main chat flow to prevent state pollution.
- **Auto-Refine Persona & Context Fix:** Refactored `generateAutoRefineResponse` to isolate the critic persona (using a separate `criticConfig` with a low temperature and specific system instruction) and preserve the full conversation history during the refinement step. Prompts were restructured with strict XML boundaries and stealth directives to prevent the AI from exposing the internal review process. Added a "Tool Call Bypass" to immediately return the initial response without refinement if the model issues a function call.
- **Tool Loop Fix:** Resolved a critical "Tool Loop Drop-out" bug in `services/llm/chat.ts`. The `getFullChatResponse` function now correctly appends `response.text` within the tool execution loop and properly transitions to `auto_refine` mode if enabled.
- **Enhanced Thinking:** Added `'auto_refine'` as a new `enhancedThinkingMode` in `GeminiSettings`. Integrated custom critic instructions and iteration limits into the `SettingsToolsContext.tsx` UI.

### D. Chat Header Model Selector Refactor (LATE MARCH 2026)
- **Multi-line Wrapping:** Refactored the Model Selector in `ChatHeader.tsx` to support multi-line wrapping for long model names.
- **Header Dynamics:** Replaced fixed height `h-14 sm:h-16` with `min-h-[3.5rem] sm:min-h-[4rem] h-auto` to allow the header to expand vertically if needed.
- **Button Constraints:** Updated model display buttons to use `h-auto min-h-[1.5rem]` and increased `max-w` to `240px` for better readability of technical IDs.
- **Icon Protection:** Added `flex-shrink-0` to all icons within the model selector to prevent distortion during text wrapping.
- **Typography:** Removed `truncate` from model names, adding `whitespace-normal break-words` and `leading-[1.1]` for clean multi-line rendering.

### E. Settings UI Responsiveness Refactor (LATE MARCH 2026)
- **Active Capabilities Alignment:** Refactored `SettingsToolsContext.tsx` to ensure perfect layout on mobile (320px).
- **Python Mode Switcher:** Updated the Python execution mode switcher to span full-width on mobile with `flex-1` buttons and `text-[10px]`.
- **Margin & Padding Optimization:** Replaced fixed `ms-11` with responsive `ms-2 sm:ms-11` and adjusted indents for better readability on small screens.
- **Form Element Reflow:** Converted several `flex-row` layouts to `flex-col` on mobile, ensuring buttons and status boxes don't overflow.
- **Google Search Row:** Adjusted the Google Search toggle row to use `items-start` and `gap-2` to prevent clipping of long descriptions.

### F. Mobile UI Clipping & Overlapping Fixes (LATE MARCH 2026)
- **Logical Positioning:** Updated `ProgressNotification.tsx` to use `end-4` instead of `right-4` for better RTL/LTR support and added `max-w-[calc(100vw-2rem)]` to prevent clipping.
- **Toast Centering:** Refactored `ToastNotification.tsx` to ensure proper centering and responsive width on small screens.
- **Flexbox Robustness:** Added `min-w-0` to the chat title and `flex-shrink-0` to critical header elements (model selector, cache button) in `ChatHeader.tsx` to prevent layout collapse.
- **Safe Area Awareness:** Implemented `env(safe-area-inset-*)` padding in the chat header to protect against notches.
- **Global Reset:** Updated `index.html` with a global `min-width: 0; min-height: 0;` reset to prevent flex items from breaking layouts.

### G. Chat Input Area Refactor: "Dynamic Layered Row" System (LATE MARCH 2026)
- **Spatial Efficiency:** Refactored `ChatInputArea.tsx` into a layered system to maximize vertical space on mobile devices.
- **Layered Layout:**
    - **Top Layer:** A conditional loading progress bar (`h-0.5 bg-emerald-500 animate-pulse`).
    - **Layer 1:** `AutoSendControls.tsx` with a slim "Active Mode" (status bar with remaining count) and a "Config Mode" (input fields).
    - **Layer 2:** `AttachmentZone.tsx` refactored into a horizontal, scrollable row (`overflow-x-auto hide-scrollbar`) with smaller file items.
    - **Layer 3 (Conditional Toolbar):** A toggleable toolbar that switches between `CharacterBar.tsx` and `PromptButtonsBar.tsx` using a switch button (`UsersIcon` or `WrenchScrewdriverIcon`).
    - **Layer 4 (Main Input Row):** A single row containing `InputActions` (Start), `ChatTextArea`, and `InputActions` (End).
- **Unified "+" Menu:** Consolidated all secondary tools (Add Files, Attachments, Context Input, Story Manager, Strategic Protocol, User Profile) into a single `Dropdown` menu in `InputActions.tsx`.
- **Priority-Based Action Buttons:** Implemented a priority system for the right-side action buttons:
    - **Priority 1:** `StopIcon` (if `isLoading` or `isAutoSendingActive`).
    - **Priority 2:** `SendIcon` (if `!isCharacterMode`).
    - **Priority 3:** `MicrophoneIcon` (if `isCharacterMode`).
- **Responsive Padding:** Added `px-2 sm:px-4` and `p-2 sm:p-3` to ensure a tight, professional fit on small screens.

### I. Chat Status Footer & Floating Thinking Pill (LATE MARCH 2026)
- **Relocation:** Moved the "Thinking Indicator" and "Generation Timer" from the header, chat bubbles, and message list footer to a single, elegant floating pill above the `ChatInputArea.tsx`.
- **Floating Pill Implementation:** The pill uses `AnimatePresence` and `motion` for smooth entrance/exit. It is positioned absolutely above the input area (`bottom-full mb-2`), ensuring it's always centered horizontally during generation. The styling is minimalist, transparent, and significantly smaller (text size `text-[9px]`) to maintain a clean, "ghost-like" aesthetic.
- **Continue Flow Button:** The "Continue Flow" button remains at the end of the `ChatMessageList.tsx` (within the observed scrollable area) to maintain logical flow after model responses.
- **Auto-Scroll Integration:** The `ChatMessageList.tsx` footer (containing the Continue button) is part of the observed scrollable area (`virtualizerContainerRef`), ensuring that when it appears, the `ResizeObserver` triggers an auto-scroll.
- **Manual Scroll Respect:** Refactored scroll logic to strictly respect user's manual scroll position. The UI no longer forces a scroll to the bottom if the user has manually scrolled up to read history, even when new messages arrive or deletions occur. "Stickiness" is only maintained if the user is already at the bottom or explicitly clicks the "Scroll to Bottom" button.

### H. Viewport-Aware & RTL Dropdown System (LATE MARCH 2026)
- **Unified Dropdown:** Refactored the atomic `<Dropdown />` component in `components/ui/Dropdown.tsx` to be the single source of truth for all popup menus.
- **Viewport Awareness:** Implemented dynamic positioning logic using `useLayoutEffect` to calculate menu placement. Dropdowns now automatically flip vertically (up/down) and align horizontally (left/right) to prevent overflowing screen edges.
- **RTL Compatibility:** Added native support for Right-to-Left layouts (`document.documentElement.dir === 'rtl'`), ensuring menus anchor correctly to the right edge in RTL environments.
- **Migration:** Consolidated custom portal-based menus in `InputActions.tsx` (the "+" menu) and `ChatToolsMenu.tsx` (the "Wrench" menu) into the unified `<Dropdown />` component.
- **Interaction Polish:** Adopted a function-as-child pattern `({ close }) => ...` to allow menu items to explicitly close the dropdown upon interaction.
- **Animation Consistency:** Updated the global `fade-in` animation in `index.html` to be direction-neutral, ensuring smooth transitions regardless of the menu's opening direction.

### J. Chat Footer & Auto-Reveal Optimization (LATE MARCH 2026)
- **Ghost Gap Elimination:** Refactored `ChatMessageList.tsx` to conditionally render the chat status footer container only when the "Continue Flow" button is actually needed. This eliminates the empty space ("ghost gap") at the bottom of the chat when no button is present.
- **Spacing Tightening:** Reduced vertical margins on the footer container from `mt-6 mb-10` to `mt-4 mb-4` for a more compact layout.
- **Smart Stickiness Fix:** Modified the `ResizeObserver` in `ChatMessageList.tsx` to trigger auto-scroll whenever `isPinned` is true, regardless of whether streaming is active. This ensures the "Continue Flow" button is automatically revealed when it appears, and that late-loading attachments (like images) don't push the viewport away from the bottom.
- **Logic Centralization:** Centralized the "Continue Flow" visibility logic into a single `shouldShowContinueButton` constant for better maintainability.

### K. Zero-Padding Chat Layout & Ghost Footer Removal (LATE MARCH 2026)
- **Native Flexbox Layout:** Refactored the chat layout to rely entirely on native Flexbox (`flex-col` + `flex-1`). Removed all artificial bottom padding from the message list (`pb-0`).
- **Ghost Footer Fix:** Implemented strict conditional rendering for the Chat Status Footer container. The container now only renders when the "Continue Flow" button is active, ensuring it takes up zero vertical space when empty.
- **Tightened Margins:** Reduced footer margins to `mt-2 mb-2` for a more integrated look.
- **Layout Stability:** By removing dynamic padding and relying on standard CSS layout, we ensure maximum compatibility with the virtualizer's coordinate system and prevent layout jumps.

### L. Global Pure CSS Modal Animations (LATE MARCH 2026)
- **Performance Optimization:** Replaced `framer-motion` with hardware-accelerated pure CSS animations (`animate-modal-open`) for all modals and panels across the app. This eliminates mobile jank during modal mounting and unmounting.
- **Zero-Refactor Approach:** Applied the `animate-modal-open` class directly to the inner container `div` of hardcoded modals, avoiding complex refactoring while achieving global animation consistency.
- **Snappy Transitions:** Tuned the CSS animation duration to `0.2s` in `index.html` for a more responsive and professional feel.
- **BaseModal Refactor:** Refactored `BaseModal.tsx` to remove `AnimatePresence` and `motion.div`, relying on standard `div` elements and the `animate-modal-open` class. Updated the transition timeout to `200ms` to match the CSS animation.

### M. Mobile Toolbar "Fixed-Scroll-Fixed" Pattern (LATE MARCH 2026)
- **Standardization:** Standardized all toolbars (Selection ActionBar, PromptButtonsBar, CharacterBar) to use a three-part flex system: Fixed Start, Scrollable Center, and Fixed End.
- **Mobile UX:** This pattern prevents UI squashing on small screens by allowing action buttons to scroll horizontally while keeping primary navigation and status indicators pinned.
- **Logical Properties:** Enforced the use of CSS Logical Properties (`ms-`, `me-`) instead of physical ones (`ml-`, `mr-`) to ensure universal RTL/LTR compatibility.
- **Visual Clarity:** Removed `hidden sm:inline` from action buttons in the selection bar to ensure all labels are visible on mobile, and added `whitespace-nowrap` + `flex-shrink-0` to prevent text wrapping or button shrinking.
- **Critical Rule:** Never use flex items directly inside a scrollable flex container for toolbars, as this can cause unpredictable shrinking or hidden scrollbars. Always use the "Bulletproof Scrolling Pattern": an outer container with `flex-1 min-w-0 overflow-x-auto` and an inner container with `w-max flex items-center`.

### N. Twilight / Dimmed (Evening Mode) Light Theme (LATE MARCH 2026)
- **Visual Comfort:** Implemented a new "Twilight / Dimmed" light theme to completely eliminate screen glare and create a very low-contrast reading environment.
- **Zinc Palette:** Migrated light mode CSS variables to a mid-tone Zinc-based palette (`Zinc 300` for app background, `Zinc 200` for panels).
- **Variable Updates:** Updated 10 core RGB variables in `:root` including `--bg-app` (212 212 216), `--bg-panel` (228 228 231), and `--bg-hover` (161 161 170) for a comfortable, evening-inspired experience.
- **Bubble Refinement:** Adjusted `--bg-bubble-user` to a muted, desaturated teal (204 229 223) to blend with the dimmed gray aesthetic.

### O. Ternary Theme System (Light, Dark, Studio) (LATE MARCH 2026)
- **Architecture Upgrade:** Expanded the theming system from binary (light/dark) to ternary (`light`, `dark`, `studio`).
- **Studio Theme:** Implemented a new "Studio" theme based on Google AI Studio's Material 3 Dark palette, using deep grays (`#1e1f20`, `#2b2c2e`) and vibrant blue accents (`#8ab4f8`).
- **Global State:** Updated `useGlobalUiStore.ts` to support the ternary state and cycle through themes sequentially.
- **FOUC Prevention:** Updated the inline script in `index.html` to handle the `studio` theme during initial load.
- **UI Integration:** Added a new `ComputerDesktopIcon` for the studio theme and updated the Sidebar toggle button to reflect the three-theme cycle.

### P. Markdown Typography Refinement (LATE MARCH 2026)
- **Baseline Update:** Overhauled the `--md-*` color variables across all three themes (`:root`, `.dark`, `.studio`) to provide optimized, eye-friendly reading experiences.
- **Light Mode:** Switched to earthy, muted values (e.g., `#312e81` for bold, `#065f46` for italic).
- **Dark Mode:** Implemented high-contrast IDE-style pastels (e.g., `#67e8f9` for bold, `#d8b4fe` for italic).
- **Studio Mode:** Adopted Google Material 3 Dark palette colors (e.g., `#a8c7fa` for bold, `#6dd58c` for italic) to match the Studio aesthetic.

### Q. Read Mode Visual Unification (LATE MARCH 2026)
- **Background Consistency:** Refactored `ReadModeView.tsx` to use `bg-bubble-ai` instead of `bg-bg-panel` for the main content container. This ensures that the reading experience is visually unified with the AI's message bubbles across all themes (Light, Dark, and Studio).

### R. Tailored Nord Theme Markdown Typography (LATE MARCH 2026)
- **Mode-Specific Optimization:** Refined the `--md-*` variables across all three themes (`:root`, `.dark`, `.studio`) with tailored Nord palettes.
- **Light Mode (Deep/Rich):** Optimized for light gray backgrounds using deep frost blues and polar night grays.
- **Dark Mode (Bright/Crisp):** Optimized for near-black backgrounds using bright frost cyans and vibrant aurora greens/purples.
- **Studio Mode (Muted/Pastel):** Optimized for charcoal/slate backgrounds using soft frost blues and muted sage/orange tones for a low-contrast, professional look.
- **Visual Comfort:** Ensured each mode provides an eye-friendly reading experience by tuning contrast and saturation specifically for its background.

### S. Custom Dark Mode Markdown Typography (LATE MARCH 2026)
- **User-Specific Palette:** Updated the `.dark` theme in `index.css` with a custom color palette for Markdown typography:
    - **Bold:** `#6ee7b7` (Light Emerald Green) for high emphasis.
    - **Italic:** `#10b981` (Muted Emerald Green) for subtle emphasis.
    - **H3 Headings:** `#fb7185` (Muted Rose/Red).
    - **Quotes:** `#fbbf24` (Muted Amber) with a Zinc 400 (`#a1a1aa`) text color.
    - **Links:** `#60a5fa` (Soft Blue).
- **Visual Contrast:** This custom palette provides high legibility and a distinct, vibrant look specifically for the dark theme.

### T. Standardized Markdown Color Semantics (LATE MARCH 2026)
- **Semantic Alignment:** Standardized Markdown typography colors across Light (`:root`) and Studio (`.studio`) themes to follow a consistent logic: Bold = Prominent Green, Italic = Muted Green, H3 = Muted Red.
- **Light Mode Optimization:** Applied deep, high-contrast Emerald and Rose tones (`#047857`, `#be123c`) for maximum readability on light gray backgrounds.
- **Studio Mode Optimization:** Applied soft, pastel Google-style greens and corals (`#81c995`, `#f28b82`) to maintain a professional, low-contrast look on charcoal backgrounds.
- **Contrast Tuning:** Each theme's palette was specifically tuned to its background to ensure eye comfort and accessibility.

### U. Legacy "Charcoal/Evening" Theme Replication (LATE MARCH 2026)
- **Studio Theme Overhaul:** Replicated the user's legacy "Charcoal/Evening" theme exactly into the `.studio` theme block.
- **UI Variables:** Updated all UI RGB variables (e.g., `--bg-app: 33 33 33`, `--text-primary: 236 236 236`) to match reverse-engineered legacy values.
- **Markdown Variables:** Restored legacy HEX Markdown colors (e.g., `--md-bold: #93c5fd`, `--md-italic: #16a34a`) for a familiar reading experience in Studio mode.
- **Preservation:** Kept existing brand, ring, and tint colors intact to maintain functional consistency with the new atomic component system.

### V. Unified Markdown Color Semantics (LATE MARCH 2026)
- **Semantic Alignment:** Unified Markdown typography colors across Light (`:root`) and Dark (`.dark`) themes to match the legacy scheme: Bold = Blue, Italic = Green, H3 = Red, Quote = Amber.
- **Light Mode Optimization:** Applied deep, high-contrast shades (`#1d4ed8`, `#15803d`, `#dc2626`, `#b45309`) for maximum readability on light gray backgrounds.
- **Dark Mode Optimization:** Applied bright, vibrant shades (`#60a5fa`, `#4ade80`, `#ff6b6b`, `#fbbf24`) extracted from the legacy dark theme for high legibility on near-black backgrounds.
- **Consistency:** This update ensures a uniform visual language across all three themes while maintaining optimal contrast for each background.

### W. Seamless Merge UI Strategy (LATE MARCH 2026)
- **Objective:** Resolved "Over-boxing" (excessive layering) by implementing a "Seamless Merge" strategy across the chat input and message components.
- **Implementation:** Replaced `bg-bg-element` with `bg-transparent` in nested components (AutoSendControls, PromptButtonsBar, CharacterBar, AttachmentZone, Code Blocks, Accordions, Python Blocks).
- **Visual Logic:** Sections are now separated by subtle borders (`border-border-base`) rather than chunky background colors, creating a flatter, more unified UI that blends perfectly with the parent container's background (`bg-bg-panel` or `bg-bubble-ai`).
- **Consistency:** This ensures that nested toolbars and internal content areas don't create harsh, disjointed boxes, especially in Dark and Studio themes.

### X. Borderless Surface UI Strategy (LATE MARCH 2026)
- **Objective:** Refined UI primitives and sub-components to adopt a "Borderless Surface" strategy, removing visual noise and excessive boxing for a cleaner, more unified aesthetic.
- **Implementation:** 
    - **UI Primitives:** Removed default borders from `Input`, `Textarea`, and `Select` components (`border-transparent` by default).
    - **Chat Input Area:** Eliminated internal borders between `AutoSendControls`, `PromptButtonsBar`, `CharacterBar`, and `AttachmentZone`.
    - **Settings Cards:** Removed full outlines (`border border-border-base`) from settings cards, keeping only the colored left ribbons (`border-s-4`) for a lighter, more modern feel.
- **Visual Logic:** By eliminating unnecessary borders, the UI feels more integrated and less "boxed-in," relying on spacing and subtle background shifts (or colored ribbons) for structural definition.

### Y. 3-Layer Elevation Strategy (LATE MARCH 2026)
- **Objective:** Established a clear visual hierarchy and depth across all themes (Light, Dark, Studio) to eliminate "flatness" and improve spatial awareness.
- **Hierarchy:**
    - **Layer 1 (Deepest):** `--bg-app` (The application canvas).
    - **Layer 2 (Middle):** `--bg-bubble-ai` (AI message bubbles).
    - **Layer 3 (Top):** `--bg-panel` (Floating UI elements like Headers, Modals, and Input Areas).
- **Implementation:** Updated background RGB variables in `index.css` to ensure consistent contrast ratios. In all themes, the background moves from darkest/deepest (`bg-app`) to lightest/elevated (`bg-panel`).

### Z. Read Mode Glassmorphism Refinement (LATE MARCH 2026)
- **Objective:** Fixed the "Over-opacity" issue in the Read Mode backdrop to achieve a proper glassmorphism effect.
- **Implementation:** 
    - **Backdrop:** Switched from `bg-bg-panel/90` to `bg-bg-overlay/60` (dedicated black overlay).
    - **Blur:** Increased from `backdrop-blur-sm` to `backdrop-blur-md` for a more elegant frosted effect.
- **Visual Logic:** This ensures the chat history remains visible but beautifully blurred behind the modal, improving depth and focus.

### AA. AutoSendControls Flexbox Layout Fix (LATE MARCH 2026)
- **Objective:** Resolved a layout issue in `AutoSendControls.tsx` where the text input didn't correctly expand to fill space, and the number input/button were squashed on small screens.
- **Implementation:** 
    - Wrapped the text `<Input>` in a `div` with `flex-1 min-w-0`.
    - Wrapped the number `<Input>` in a `div` with `w-16 sm:w-20 flex-shrink-0`.
    - Added `flex-shrink-0` to the Start `<Button>`.
- **Visual Logic:** This ensures the main text input always takes the maximum available space while keeping the secondary controls at a fixed, predictable size, preventing layout collapse on mobile.

### AB. Dark Mode AI Bubble Refinement (LATE MARCH 2026)
- **Objective:** Made the AI message bubble background slightly lighter in Dark Mode to improve contrast and readability.
- **Implementation:** Updated `--bg-bubble-ai` in the `.dark` block of `index.css` from `24 24 27` to `32 32 35`.
- **Visual Logic:** This provides a clearer distinction between the AI messages and the application background (`--bg-app`), enhancing the overall depth and visual clarity of the chat interface in dark mode.

### AC. Muted Dark Mode Markdown Colors (LATE MARCH 2026)
- **Objective:** Updated Markdown typography colors in Dark Mode to be more "muted" (matte) for better eye comfort during long reading sessions.
- **Implementation:** Replaced vibrant shades with a desaturated, Nord-inspired palette in the `.dark` block of `index.css`.
    - **Bold:** `#81a1c1` (Muted Blue)
    - **Italic:** `#a3be8c` (Muted Green)
    - **H3:** `#bf616a` (Muted Red)
    - **Quote:** `#d08770` (Muted Orange)
    - **Link:** `#88c0d0` (Muted Cyan)
- **Visual Logic:** This reduces visual fatigue by lowering the saturation of highlighted text while maintaining clear semantic differentiation.

1. **Feature Isolation:** When introducing a NEW feature, DO NOT bloat existing files. Create a NEW, dedicated file and import it. Every file must maintain a single responsibility.
2. **Native Alerts:** NEVER use `window.alert`, `window.confirm`, or `window.prompt`. Always use `useToastStore`, `useConfirmationUI`, or `useEditorUI.getState().openFilenameInputModal`.
3. **Zustand Selectors:** Always use `useShallow` when selecting multiple properties from a store to prevent unnecessary re-renders.
   *Bad:* `const { a, b } = useStore();`
   *Good:* `const { a, b } = useStore(useShallow(state => ({ a: state.a, b: state.b })));`
4. **Translations:** Hardcoded English strings in UI components are strictly forbidden. Always use `const { t } = useTranslation();` and add new keys to `translations.ts`.
