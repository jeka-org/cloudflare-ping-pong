// Pure physics functions for pong game - fully testable, no dependencies

export interface Ball {
  x: number; // 0-1 range (normalized coordinates)
  y: number; // 0-1 range
  vx: number; // velocity x
  vy: number; // velocity y
}

export interface Paddle {
  y: number; // center position 0-1
  height: number; // typically 0.15
}

export const PADDLE_HEIGHT = 0.15;
export const PADDLE_WIDTH = 0.02;
export const BALL_RADIUS = 0.01;
export const INITIAL_BALL_SPEED = 0.008;
export const SPEED_INCREASE_FACTOR = 1.05; // 5% speed increase per hit
export const MAX_BALL_SPEED = 0.025;
export const MAX_BOUNCE_ANGLE = Math.PI / 4; // 45 degrees

/**
 * Update ball position based on velocity
 */
export function updateBall(ball: Ball): Ball {
  return {
    ...ball,
    x: ball.x + ball.vx,
    y: ball.y + ball.vy,
  };
}

/**
 * Check and handle wall bounces (top and bottom)
 */
export function checkWallBounce(ball: Ball): Ball {
  let newBall = { ...ball };
  
  // Top wall
  if (newBall.y - BALL_RADIUS <= 0) {
    newBall.y = BALL_RADIUS;
    newBall.vy = Math.abs(newBall.vy);
  }
  
  // Bottom wall
  if (newBall.y + BALL_RADIUS >= 1) {
    newBall.y = 1 - BALL_RADIUS;
    newBall.vy = -Math.abs(newBall.vy);
  }
  
  return newBall;
}

/**
 * Check paddle collision and calculate new ball trajectory
 */
export function checkPaddleCollision(
  ball: Ball,
  paddleY: number,
  side: 'left' | 'right'
): { hit: boolean; ball: Ball } {
  const newBall = { ...ball };
  
  // Check if ball is at paddle x position
  const atLeftPaddle = side === 'left' && ball.x - BALL_RADIUS <= PADDLE_WIDTH;
  const atRightPaddle = side === 'right' && ball.x + BALL_RADIUS >= 1 - PADDLE_WIDTH;
  
  if (!atLeftPaddle && !atRightPaddle) {
    return { hit: false, ball: newBall };
  }
  
  // Check if ball y is within paddle range
  const paddleTop = paddleY - PADDLE_HEIGHT / 2;
  const paddleBottom = paddleY + PADDLE_HEIGHT / 2;
  const ballInPaddleRange = ball.y >= paddleTop && ball.y <= paddleBottom;
  
  if (!ballInPaddleRange) {
    return { hit: false, ball: newBall };
  }
  
  // Hit! Calculate new trajectory
  // Position ball outside paddle to prevent multiple collisions
  if (side === 'left') {
    newBall.x = PADDLE_WIDTH + BALL_RADIUS;
  } else {
    newBall.x = 1 - PADDLE_WIDTH - BALL_RADIUS;
  }
  
  // Reverse x direction
  newBall.vx = -ball.vx;
  
  // Add angle based on where ball hit paddle (center = 0, edges = max angle)
  const hitPosition = (ball.y - paddleY) / (PADDLE_HEIGHT / 2); // -1 to 1
  const bounceAngle = hitPosition * MAX_BOUNCE_ANGLE;
  
  // Calculate new velocity maintaining speed but changing angle
  const currentSpeed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
  const newSpeed = Math.min(currentSpeed * SPEED_INCREASE_FACTOR, MAX_BALL_SPEED);
  
  newBall.vx = Math.cos(bounceAngle) * newSpeed * (side === 'left' ? 1 : -1);
  newBall.vy = Math.sin(bounceAngle) * newSpeed;
  
  return { hit: true, ball: newBall };
}

/**
 * Check if ball scored (passed left or right edge)
 */
export function checkScore(ball: Ball): { scored: boolean; scorer: number | null } {
  // Player 2 scores (ball passed left edge)
  if (ball.x - BALL_RADIUS <= 0) {
    return { scored: true, scorer: 2 };
  }
  
  // Player 1 scores (ball passed right edge)
  if (ball.x + BALL_RADIUS >= 1) {
    return { scored: true, scorer: 1 };
  }
  
  return { scored: false, scorer: null };
}

/**
 * Reset ball to center with random direction
 */
export function resetBall(towardsPlayer?: 1 | 2): Ball {
  const angle = (Math.random() - 0.5) * Math.PI / 3; // -30 to +30 degrees
  const direction = towardsPlayer === 1 ? -1 : towardsPlayer === 2 ? 1 : (Math.random() < 0.5 ? -1 : 1);
  
  return {
    x: 0.5,
    y: 0.5,
    vx: Math.cos(angle) * INITIAL_BALL_SPEED * direction,
    vy: Math.sin(angle) * INITIAL_BALL_SPEED,
  };
}

/**
 * Create initial paddle state
 */
export function createPaddle(y: number = 0.5): Paddle {
  return { y, height: PADDLE_HEIGHT };
}
