/** Keep only characters introduced by the user when the surrounding snapshot becomes inaccessible. */
export function editedCharacters(before: string, after: string, previous: readonly boolean[] = []) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length,
    newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return Array.from({ length: after.length }, (_, i) => {
    if (i < start) return previous[i] === true;
    if (i >= newEnd) return previous[oldEnd + i - newEnd] === true;
    return true;
  });
}
