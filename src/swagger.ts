import swaggerJsdoc from "swagger-jsdoc";

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Tollgate",
      version: "1.0.0",
      description: "Rate-limiting gateway — token-bucket & sliding-window",
    },
    servers: [
      {
        url: "https://tollgate-8cj5.onrender.com",
        description: "Production",
      },
    ],
    components: {
      schemas: {
        ClientConfig: {
          type: "object",
          required: ["algorithm", "requestPerSecond", "burstSize", "windowSize"],
          properties: {
            algorithm: {
              type: "string",
              enum: ["token-bucket", "sliding-window"],
              example: "token-bucket",
            },
            requestPerSecond: { type: "number", example: 50 },
            burstSize: { type: "number", example: 100 },
            windowSize: { type: "number", example: 60 },
          },
        },
      },
    },
  },
  apis: ["./src/routes/*.ts"],
};

export const swaggerSpec = swaggerJsdoc(options);   