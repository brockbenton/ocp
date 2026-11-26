import { Router, Request, Response } from 'express';
import { renderSemesterBadgeSvg, renderFoundingBadgeSvg } from '../services/art.service';

const router = Router();

function sendSvg(res: Response, svg: string): void {
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  // These images are embedded by the frontend and by token viewers on other origins.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.send(svg);
}

// Public, generated SVG assets: per-semester token badge and the founding-member badge.
router.get('/art/:semester', (req: Request, res: Response): void => {
  sendSvg(res, renderSemesterBadgeSvg(req.params.semester));
});

router.get('/badge/founding', (_req: Request, res: Response): void => {
  sendSvg(res, renderFoundingBadgeSvg());
});

export default router;
