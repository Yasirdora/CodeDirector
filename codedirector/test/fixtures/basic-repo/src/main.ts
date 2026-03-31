import { Service } from "./service";

const service = new Service();
const result = service.run([{ price: 21 }]);

console.log(`total: ${result}`);
