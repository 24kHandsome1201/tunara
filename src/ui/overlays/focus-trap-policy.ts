export function shouldRestoreFocusAfterTrapUnmount(
  activeInsideClosingTrap: boolean,
  activeAtDocumentRoot: boolean,
): boolean {
  return activeInsideClosingTrap || activeAtDocumentRoot;
}
