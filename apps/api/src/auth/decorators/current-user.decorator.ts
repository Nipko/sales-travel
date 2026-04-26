import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { currentUserId } from '../../request-context/request-context.js';

export const CurrentUser = createParamDecorator((_data: unknown, _ctx: ExecutionContext) => {
  return currentUserId();
});
