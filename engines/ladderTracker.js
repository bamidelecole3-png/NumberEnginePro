'use strict';

const LADDER_SIZE = 5;

function ladderProgress(drawCount, size = LADDER_SIZE) {
  const current = drawCount % size;
  const remaining = size - current;
  const complete = current === 0 && drawCount > 0;
  return {
    current: current === 0 && drawCount > 0 ? size : current,
    remaining: current === 0 && drawCount > 0 ? 0 : remaining,
    complete,
    ladderSize: size,
    label: `${current === 0 && drawCount > 0 ? size : current}/${size}`
  };
}

module.exports = {
  ladderProgress,
  LADDER_SIZE
};
