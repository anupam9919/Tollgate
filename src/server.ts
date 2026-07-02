import 'dotenv/config';
import express from 'express';
import checkRouter from './routes/check';
import {connectRedis} from './redisClient';

const app = express();
app.use(express.json());
app.use('/check',checkRouter);

const PORT = process.env.PORT || 3000;

connectRedis().then(() => {
    app.listen(PORT, () => {
        console.log(`Tollgate is running on port ${PORT}`);
    });
});