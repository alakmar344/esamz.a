import express from "express";
import "./db.js";

import internal from "./api/internal.js";
import activate from "./api/activate.js";
import me from "./api/me.js";
import voice from "./api/voice.js";

const app = express();
app.use(express.json());

app.use("/api/internal", internal);
app.use("/api", activate);
app.use("/api", me);
app.use("/api", voice);

app.listen(3000, () => {
  console.log("eSAMz API running on port 3000");
});
