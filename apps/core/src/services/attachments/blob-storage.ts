import { createHash } from 'crypto'
import { closeSync, constants, fchmodSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getHomeDir } from '../../lib/utils/home'
import { createLogger } from '../../lib/infra/logger'
import { descriptorRelativeFs as descriptor } from './materialize'

const log = createLogger('attachment-blob-storage')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** A home-directory collection of immutable blobs, one directory per owner (`<home>/<directory>/<owner>/<id>`). */
interface BlobCollection {
  directory: string
  ownerLabel: string
}
const AGENT_FILES: BlobCollection = { directory: 'agent-file-attachments', ownerLabel: 'agent' }
const WORKFLOW_ATTACHMENTS: BlobCollection = { directory: 'workflow-attachments', ownerLabel: 'work stream' }

function normalizeUuid(value: string, label: string): string {
  if (!UUID_RE.test(value)) throw new Error(`Invalid ${label} id`)
  return value.toLowerCase()
}

function collectionBlobPath(collection: BlobCollection, ownerId: string, attachmentId: string): string {
  return join(
    getHomeDir(),
    collection.directory,
    normalizeUuid(ownerId, collection.ownerLabel),
    normalizeUuid(attachmentId, 'attachment')
  )
}

export function agentAttachmentBlobPath(agentId: string, attachmentId: string): string {
  return collectionBlobPath(AGENT_FILES, agentId, attachmentId)
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export interface BlobStorageTestHooks {
  afterAgentDirectoryOpened?: () => Promise<void>
  afterPrePublishValidation?: (stagingBasename: string) => Promise<void>
}

export async function writeAgentAttachmentBlob(
  agentId: string,
  attachmentId: string,
  bytes: Uint8Array,
  testHooks: BlobStorageTestHooks = {}
): Promise<string> {
  return writeCollectionBlob(AGENT_FILES, agentId, attachmentId, bytes, testHooks)
}

async function writeCollectionBlob(
  blobs: BlobCollection,
  ownerId: string,
  attachmentId: string,
  bytes: Uint8Array,
  testHooks: BlobStorageTestHooks = {}
): Promise<string> {
  const collectionName = blobs.directory
  const homePath = getHomeDir()
  const normalizedOwnerId = normalizeUuid(ownerId, blobs.ownerLabel)
  const normalizedAttachmentId = normalizeUuid(attachmentId, 'attachment')
  const collectionPath = join(homePath, collectionName)
  const ownerPath = join(collectionPath, normalizedOwnerId)
  const finalPath = join(ownerPath, normalizedAttachmentId)
  let published = false
  const home = openSync(homePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    descriptor.assertHeldPath(home, homePath)
    descriptor.mkdirAt(home, collectionName)
    const collectionIdentity = descriptor.pathIdentity(collectionPath)
    const collection = descriptor.openHeldDirectory(home, homePath, collectionName, collectionIdentity)
    try {
      descriptor.mkdirAt(collection, normalizedOwnerId)
      const ownerIdentity = descriptor.pathIdentity(ownerPath)
      const directory = descriptor.openHeldDirectory(collection, collectionPath, normalizedOwnerId, ownerIdentity)
      try {
        await testHooks.afterAgentDirectoryOpened?.()
        descriptor.assertHeldPath(directory, ownerPath)
        const temporary = descriptor.createTemporaryFile(homePath)
        let stagingAnchored = false
        let stagingRemoved = false
        let finalCreated = false
        let finalFd = -1
        try {
          fchmodSync(temporary.fd, 0o600)
          const temporaryIdentity = descriptor.heldIdentity(temporary.fd)
          const stagingFd = descriptor.openAt(
            home,
            temporary.basename,
            constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
          )
          try {
            descriptor.assertHeldIdentity(stagingFd, temporaryIdentity)
            descriptor.assertHeldPath(stagingFd, temporary.path)
            stagingAnchored = true
          } finally {
            closeSync(stagingFd)
          }
          writeFileSync(temporary.fd, bytes)
          fsyncSync(temporary.fd)
          descriptor.assertHeldPath(home, homePath)
          descriptor.assertHeldPath(collection, collectionPath)
          descriptor.assertHeldPath(directory, ownerPath)
          descriptor.assertHeldPath(temporary.fd, temporary.path)
          if (testHooks.afterPrePublishValidation) {
            await testHooks.afterPrePublishValidation(temporary.basename)
          }
          finalCreated = descriptor.linkTemporaryFile(temporary, home, directory, normalizedAttachmentId)
          if (!finalCreated) {
            descriptor.unlinkStagingAt(home, temporary.basename)
            stagingRemoved = true
            throw Object.assign(new Error('ATTACHMENT_BLOB_EXISTS'), { code: 'EEXIST' })
          }
          finalFd = descriptor.openAt(
            directory,
            normalizedAttachmentId,
            constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
          )
          descriptor.assertSafeRegularFile(finalFd, bytes.byteLength)
          descriptor.assertHeldIdentity(finalFd, temporaryIdentity)
          published = true
          try {
            descriptor.unlinkStagingAt(home, temporary.basename)
            stagingRemoved = true
          } catch (error) {
            // The immutable final is already committed; metadata must not roll back.
            log.warn('Published attachment blob but could not remove staging link:', error)
          }
          return finalPath
        } catch (error) {
          const cleanupErrors: unknown[] = []
          if (!stagingRemoved) {
            try {
              if (stagingAnchored) descriptor.unlinkStagingAt(home, temporary.basename)
              else unlinkSync(temporary.path)
            } catch (failure) {
              cleanupErrors.push(failure)
            }
          }
          if (finalCreated && !published) {
            try {
              descriptor.unlinkAt(directory, normalizedAttachmentId)
            } catch (failure) {
              cleanupErrors.push(failure)
            }
          }
          if (cleanupErrors.length) {
            throw new AggregateError([error, ...cleanupErrors], 'Attachment blob cleanup failed')
          }
          throw error
        } finally {
          descriptor.closeMaterializationDescriptors([finalFd, temporary.fd], published)
        }
      } finally {
        descriptor.closeMaterializationDescriptors([directory], published)
      }
    } finally {
      descriptor.closeMaterializationDescriptors([collection], published)
    }
  } finally {
    descriptor.closeMaterializationDescriptors([home], published)
  }
}

function openBlobDescriptors(
  blobs: BlobCollection,
  ownerId: string,
  attachmentId: string,
  includeFile = true
): {
  home: number
  collection: number
  directory: number
  file: number
} {
  const collectionName = blobs.directory
  const homePath = getHomeDir()
  const normalizedOwnerId = normalizeUuid(ownerId, blobs.ownerLabel)
  const normalizedAttachmentId = normalizeUuid(attachmentId, 'attachment')
  const collectionPath = join(homePath, collectionName)
  const home = openSync(homePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    descriptor.assertHeldPath(home, homePath)
    const collection = descriptor.openHeldDirectory(home, homePath, collectionName)
    try {
      const directory = descriptor.openHeldDirectory(collection, collectionPath, normalizedOwnerId)
      try {
        const file = includeFile
          ? descriptor.openAt(
              directory,
              normalizedAttachmentId,
              constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
            )
          : -1
        return { home, collection, directory, file }
      } catch (error) {
        closeSync(directory)
        throw error
      }
    } catch (error) {
      closeSync(collection)
      throw error
    }
  } catch (error) {
    closeSync(home)
    throw error
  }
}

export async function readVerifiedAgentAttachmentBlob(
  agentId: string,
  attachmentId: string,
  byteSize: number,
  sha256: string
): Promise<Buffer> {
  return readVerifiedCollectionBlob(AGENT_FILES, agentId, attachmentId, byteSize, sha256)
}

async function readVerifiedCollectionBlob(
  blobs: BlobCollection,
  ownerId: string,
  attachmentId: string,
  byteSize: number,
  sha256: string
): Promise<Buffer> {
  const opened = openBlobDescriptors(blobs, ownerId, attachmentId)
  try {
    descriptor.assertSafeRegularFile(opened.file, byteSize)
    const bytes = readFileSync(opened.file)
    if (sha256Hex(bytes) !== sha256) throw new Error('ATTACHMENT_BLOB_CORRUPT')
    return bytes
  } catch (error) {
    if (error instanceof Error && error.message === 'ATTACHMENT_MATERIALIZATION_CONFLICT') {
      throw new Error('ATTACHMENT_BLOB_CORRUPT')
    }
    throw error
  } finally {
    descriptor.closeMaterializationDescriptors([opened.file, opened.directory, opened.collection, opened.home], false)
  }
}

export async function deleteAgentAttachmentBlob(agentId: string, attachmentId: string): Promise<void> {
  return deleteCollectionBlob(AGENT_FILES, agentId, attachmentId)
}

async function deleteCollectionBlob(blobs: BlobCollection, ownerId: string, attachmentId: string): Promise<void> {
  const opened = openBlobDescriptors(blobs, ownerId, attachmentId, false)
  try {
    descriptor.unlinkAt(opened.directory, normalizeUuid(attachmentId, 'attachment'))
  } finally {
    descriptor.closeMaterializationDescriptors([opened.file, opened.directory, opened.collection, opened.home], false)
  }
}

/** The directory holding one work stream's handoff attachments. */
export function workflowAttachmentDirectory(workStreamId: string): string {
  return join(
    getHomeDir(),
    WORKFLOW_ATTACHMENTS.directory,
    normalizeUuid(workStreamId, WORKFLOW_ATTACHMENTS.ownerLabel)
  )
}

/** Workflow handoff attachments: `<home>/workflow-attachments/<work stream>/<attachment>`. */
export function workflowAttachmentBlobPath(workStreamId: string, attachmentId: string): string {
  return collectionBlobPath(WORKFLOW_ATTACHMENTS, workStreamId, attachmentId)
}

export async function writeWorkflowAttachmentBlob(
  workStreamId: string,
  attachmentId: string,
  bytes: Uint8Array
): Promise<string> {
  return writeCollectionBlob(WORKFLOW_ATTACHMENTS, workStreamId, attachmentId, bytes)
}

export async function readVerifiedWorkflowAttachmentBlob(
  workStreamId: string,
  attachmentId: string,
  byteSize: number,
  sha256: string
): Promise<Buffer> {
  return readVerifiedCollectionBlob(WORKFLOW_ATTACHMENTS, workStreamId, attachmentId, byteSize, sha256)
}

export async function deleteWorkflowAttachmentBlob(workStreamId: string, attachmentId: string): Promise<void> {
  return deleteCollectionBlob(WORKFLOW_ATTACHMENTS, workStreamId, attachmentId)
}
