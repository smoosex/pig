/** Terminal group-kill acknowledgements are mandatory, unlike the bounded session teardown. */
export async function exitAfterCleanup(terminals: Promise<void>, teardown: Promise<unknown>, exit: (code: number) => void): Promise<void> {
  try {
    await Promise.all([terminals, teardown])
  } catch (error) {
    // Fatal process boundary: cleanup failure must not be reported as a successful quit.
    console.error('Pig shutdown failed:', error)
    exit(1)
    return
  }
  exit(0)
}
