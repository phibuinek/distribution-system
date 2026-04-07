import { Controller, Get, Param, Query } from "@nestjs/common";
import { DocsService } from "./docs.service";

@Controller("docs")
export class DocsController {
  constructor(private readonly docs: DocsService) {}

  @Get(":docId")
  getDoc(@Param("docId") docId: string) {
    return this.docs.getSnapshot(docId);
  }

  @Get(":docId/ops")
  getOps(@Param("docId") docId: string, @Query("since") since?: string) {
    const rev = since ? Number(since) : 0;
    return { docId, since: rev, ops: this.docs.getOpsSince(docId, rev) };
  }
}

