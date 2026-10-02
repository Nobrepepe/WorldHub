import { register } from '../registry.js';
import { v } from '../validate.js';
import { characterWall } from '../../services/gallery-service.js';

register('gallery.characterWall', {
  payload: v.none(),
  handler: (ctx) => characterWall(ctx.library),
});
