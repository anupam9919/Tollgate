import {Request , Response, Router} from 'express';
import {redisClient} from '../redisClient';

const router=Router();

interface AdminRequestBody{
    algorithm: 'token-bucket' | 'sliding-window';
    requestPerSecond:number;
    burstSize:number;   
    windowSize:number;
}

function validateAdminRequestBody(body: any):body is AdminRequestBody{
    return(
        (body.algorithm === 'token-bucket' || body.algorithm === 'sliding-window') &&
        typeof body.requestPerSecond === 'number' && body.requestPerSecond > 0 &&
        typeof body.burstSize === 'number' && body.burstSize > 0 &&
        typeof body.windowSize === 'number' && body.windowSize > 0
    )
}

/**
 * @openapi
 * /admin/clients/{clientId}:
 *   put:
 *     summary: Set or update rate-limit config for a client
 *     tags: [Admin]
 *     parameters:
 *       - in: path
 *         name: clientId
 *         required: true
 *         schema:
 *           type: string
 *         example: cl123
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ClientConfig'
 *     responses:
 *       200:
 *         description: Config saved
 *       400:
 *         description: Invalid request body
 */
router.put('/clients/:clientId',async (req: Request, res: Response) => {
    const {clientId} = req.params;
    const body = req.body;
    
    if(!validateAdminRequestBody(body)){
        return res.status(400).json({message:'Invalid request body'});
    }

    await redisClient.set(`client:${clientId}:algorithm`, JSON.stringify(body));
    res.status(200).json({message:'Client configuration updated successfully', clientId, config: body});
});


/**
 * @openapi
 * /admin/clients/{clientId}:
 *   get:
 *     summary: Fetch current config for a client
 *     tags: [Admin]
 *     parameters:
 *       - in: path
 *         name: clientId
 *         required: true
 *         schema:
 *           type: string
 *         example: cl123
 *     responses:
 *       200:
 *         description: Client config
 *       404:
 *         description: Client not found
 */
router.get('/clients/:clientId', async(req:Request, res: Response)=>{
    const {clientId} = req.params;
    const raw = await redisClient.get(`client:${clientId}:algorithm`);

    if(!raw){
        return res.status(404).json({message:'Client not found'});
    }
    
    res.status(200).json({clientId, config: JSON.parse(raw)});
});

export default router;