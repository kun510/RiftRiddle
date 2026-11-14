function compareLists(guess, target, label) {
  const guessedValues = [...new Set(guess)];
  const targetValues = [...new Set(target)];
  const sharedValues = guessedValues.filter((value) => targetValues.includes(value));
  const status = !guessedValues.length || !targetValues.length
    ? 'unknown'
    : guessedValues.length === targetValues.length && sharedValues.length === guessedValues.length
      ? 'correct'
      : sharedValues.length > 0
        ? 'partial'
        : 'wrong';

  return { label, status, value: guessedValues.join(' / ') || 'Không rõ' };
}

function compareExact(guess, target, label) {
  return {
    label,
    status: !guess || !target ? 'unknown' : guess === target ? 'correct' : 'wrong',
    value: guess || 'Không rõ',
  };
}

function compareYear(guess, target) {
  const status = guess === target ? 'correct' : guess < target ? 'higher' : 'lower';
  return { label: 'Năm ra mắt', status, value: String(guess) };
}

export function buildClues(guess, target) {
  return [
    compareExact(guess.gender, target.gender, 'Giới tính'),
    compareLists(guess.positions, target.positions, 'Vị trí'),
    compareLists(guess.species, target.species, 'Chủng loài'),
    compareExact(guess.resource, target.resource, 'Tài nguyên'),
    compareExact(guess.rangeType, target.rangeType, 'Tầm đánh'),
    compareLists(guess.regions, target.regions, 'Khu vực'),
    compareYear(guess.releaseYear, target.releaseYear),
  ];
}
