import { Module } from "@nestjs/common";
import { DocsController } from "./docs.controller";
import { DocsService } from "./docs.service";
import { SyncGateway } from "./sync.gateway";

@Module({
  controllers: [DocsController],
  providers: [DocsService, SyncGateway],
})
export class AppModule {}

