/** Injection token for the upload virus scanner (SEC-15). */
export const VIRUS_SCANNER = Symbol('VIRUS_SCANNER');

export type ScanResult = 'CLEAN' | 'INFECTED' | 'SKIPPED';

/** Scans one upload before it is stored. An INFECTED file is refused and never stored. */
export interface VirusScanner {
  scan(body: Buffer): Promise<ScanResult>;
}

/**
 * Named adapter for “no scanner configured” (D-104): every file is recorded as SKIPPED, so the
 * gap stays visible in the data. A ClamAV adapter can replace it without touching callers.
 */
export class NoVirusScanner implements VirusScanner {
  scan(): Promise<ScanResult> {
    return Promise.resolve('SKIPPED');
  }
}
