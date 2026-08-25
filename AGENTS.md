# Pig

## Tailwind

- Prefer the spacing scale over arbitrary values. `--spacing` is `0.25rem` (4px), so `Npx / 4` is the class number: `px-[18px]` → `px-4.5`, `pl-[78px]` → `pl-19.5`, `max-w-[140px]` → `max-w-35`.
- Use fractions for percentages: `max-w-[50%]` → `max-w-1/2`.
- Only use `[…]` arbitrary values when the scale cannot express it.
- Write styles in the component with Tailwind. Do not add `*.module.css` unless Tailwind cannot express it (keyframes, `::after`, etc.).
- Icons: use `lucide-react`. Do not hand-draw SVG icons.
