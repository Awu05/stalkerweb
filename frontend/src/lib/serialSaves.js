// Wraps a save so calls run one at a time, in the order they were made — two
// quick filter toggles each send the whole list, and the later list must be
// the one the server keeps. Each call still gets its own result or error.
export function serialSaves(save) {
  let last = Promise.resolve()
  return (body) => {
    const run = last.then(() => save(body))
    last = run.catch(() => {})
    return run
  }
}
