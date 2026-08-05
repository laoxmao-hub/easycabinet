---
description: Run TypeScript type check on draco-x2 project
---

# TypeScript Type Check

Run `npx tsc --noEmit` to check for type errors without emitting files.

## Usage

```bash
npx tsc --noEmit 2>&1
```

## Variants

- **Full output**: `npx tsc --noEmit 2>&1`
- **First 10 errors only**: `npx tsc --noEmit 2>&1 | Select-Object -First 10`
- **With pretty formatting**: `npx tsc --noEmit --pretty 2>&1 | Select-Object -First 10`
- **With exit code**: `npx tsc --noEmit 2>&1; echo "EXIT: $LASTEXITCODE"`

## When to Run

- After making TypeScript/React changes to verify type correctness
- Before committing changes
- When debugging compilation errors
- As a routine check during development

## Working Directory

Always run from: `C:\Users\Quang Nhi\Downloads\draco-x2`

## Notes

- Timeout: 120000ms recommended (TypeScript compilation can be slow)
- Exit code 0 = no errors, non-zero = type errors found
- Common errors: missing properties, type mismatches, import issues
