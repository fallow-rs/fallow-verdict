# Contributing

```bash
npm install
npm run verify   # typecheck, lint, format check, tests, build
npm run test:mutation -- src/policy/mutation.ts   # mutation test of the files that you changed
```

A mutation run on every file takes too long. Give the files that you changed as paths.

- TypeScript strict, arrow functions, named exports, no `any`.
- Errors are values: return `Result`, do not throw across module boundaries.
- Tests describe behavior through public functions. The engine is always a stand-in; tests never
  call a real API.
- Changing a question's wording or criteria requires bumping `QUESTION_SET_VERSION`.
- Policy rule ids and error codes are add-only.
- Conventional commits.
