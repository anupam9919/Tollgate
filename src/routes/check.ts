import {Router, Request, Response} from 'express';
// import {client} from '../client';

const router = Router();
interface CheckRequestBody{
    clientKey: string;
}

interface CheckResponseBody{
    allowed: boolean;
}

router.post('/check', async (req: Request<{}, {}, CheckRequestBody>, res: Response<CheckResponseBody>) => {
    const { clientKey } = req.body;
    if (!clientKey) {
        return res.status(400).json({ allowed: false });
    }

    res.json({ allowed: true });
});

export default router;