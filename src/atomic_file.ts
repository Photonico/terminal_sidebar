import { rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** Keep the old file intact when a Windows reader briefly prevents replacement. */
export async function replace_file(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 6) throw error;
      // Retry only the atomic rename; deleting the destination would expose a gap.
      await delay(10 * 2 ** attempt);
    }
  }
}
