# @narumitw/pi-goal

## 0.50.0

### Minor Changes

- db4b576: Add `goal_wait` so active Goals can wait quietly for external messages or an optional bounded deadline without creating automatic continuation loops.

### Patch Changes

- d105b85: Clamp sub-ten-second `goal_wait` deadlines and report their effective delay to prevent rapid automatic wake loops.

## 0.49.7

### Patch Changes

- fa9c938: Reduce idle startup imports by loading Goal presentation, Chat networking and UI, and Sync operation-specific modules only when their routes require them.

## 0.49.6

### Patch Changes

- 6f98395: Sanitize terminal-rendered Goal text, bound terminal-tool inputs and outputs, report malformed commands in headless modes, and keep runtime smoke coverage on public Pi APIs.
