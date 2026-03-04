// Generate human-readable room names like "swift-fox" or "bold-tiger"

const adjectives = [
  'swift', 'bold', 'bright', 'calm', 'daring',
  'eager', 'fierce', 'gentle', 'happy', 'jolly',
  'kind', 'lively', 'merry', 'noble', 'proud',
  'quiet', 'rapid', 'sharp', 'steady', 'wise',
  'clever', 'brave', 'quick', 'wild', 'free',
  'cosmic', 'electric', 'golden', 'silver', 'crimson',
  'azure', 'violet', 'amber', 'jade', 'ruby',
];

const nouns = [
  'fox', 'wolf', 'bear', 'eagle', 'tiger',
  'lion', 'hawk', 'owl', 'raven', 'falcon',
  'lynx', 'puma', 'jaguar', 'panther', 'cobra',
  'dragon', 'phoenix', 'griffin', 'pegasus', 'hydra',
  'comet', 'nebula', 'quasar', 'pulsar', 'meteor',
  'storm', 'thunder', 'lightning', 'blaze', 'spark',
  'frost', 'wave', 'river', 'mountain', 'canyon',
];

/**
 * Generate a random room name in the format "adjective-noun"
 */
export function generateRoomName(): string {
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const suffix = Math.random().toString(36).substring(2, 5); // 3 random chars
  return `${adjective}-${noun}-${suffix}`;
}

/**
 * Generate a player display name like "Swift Fox"
 */
export function generatePlayerName(): string {
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return adjective.charAt(0).toUpperCase() + adjective.slice(1) + ' ' + noun.charAt(0).toUpperCase() + noun.slice(1);
}
