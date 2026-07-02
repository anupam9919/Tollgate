import 'dotenv/config';
import express from 'express';
import checkRouter from './routes/check';
import adminRouter from './routes/admin';
import {connectRedis} from './redisClient';

const app = express();
app.use(express.json());
app.use('/check',checkRouter);
app.use('/admin', adminRouter);

const PORT = process.env.PORT || 3000;

connectRedis().then(() => {
    app.listen(PORT, () => {
        console.log(`Tollgate is running on port ${PORT}`);
    });
});